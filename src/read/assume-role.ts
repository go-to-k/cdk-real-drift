// #1971: `--assume-role <arn>` — run a stack's AWS calls as an IAM role assumed from the
// ambient credentials, for CI identities whose only permission is sts:AssumeRole.
//
// Shape: each verb's stack loop calls `enterRoleScope(await stackRoleScope(...))` at the top
// of the stack's `try`. `stackRoleScope` resolves the ARN template for that stack
// (`{account}` / `{region}`, see assume-role-arn.ts), takes the ONE memoized provider for
// that ARN, and assumes the role eagerly — so an AccessDenied / untrusted role fails the
// stack up front with the ARN in the message, instead of surfacing as a scatter of per-
// resource read errors. `enterRoleScope` binds the scope to the stack's async chain
// (client-config.ts `roleScope`), where CLIENT_CREDENTIALS — the provider every SDK client
// cdkrd constructs is given — picks it up.
//
// Not covered: the CDK synth (toolkit-lib). It runs BEFORE the per-stack loop (a
// `{account}` placeholder can only be filled from the synthesized assembly), with the
// ambient credentials — exactly as `cdk synth` does; its context lookups assume the
// bootstrap lookup role themselves.
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AssumeRoleError } from '../aws-errors.js';
import type { Verb } from '../cli-args.js';
import { needsAccount, resolveAssumeRoleArn } from './assume-role-arn.js';
import {
  AMBIENT_CREDENTIALS,
  CLIENT_TIMEOUTS,
  clientRequestHandler,
  type RoleScope,
  roleScope,
} from './client-config.js';

type CredentialProvider = RoleScope['provider'];
type Credentials = Awaited<ReturnType<CredentialProvider>>;

// Refresh this long before the session expires, so a request signed just before the
// boundary never goes out with credentials that lapse in flight. A `check` on a large stack
// can outlive the default one-hour session; the memo below re-assumes when it nears expiry.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * Memoize a credential provider: one in-flight call shared by every caller, the result
 * reused until it is within REFRESH_BEFORE_EXPIRY_MS of expiring. A FAILED call is not
 * cached (the next stack retries once). Without this every client would call
 * sts:AssumeRole on its own — a stack builds dozens of clients, which is a throttle.
 */
export function memoizeCredentials(base: () => Promise<Credentials>): () => Promise<Credentials> {
  let value: Credentials | undefined;
  let inflight: Promise<Credentials> | undefined;
  const fresh = (c: Credentials): boolean =>
    c.expiration === undefined || c.expiration.getTime() - Date.now() > REFRESH_BEFORE_EXPIRY_MS;
  return () => {
    if (value && fresh(value)) return Promise.resolve(value);
    inflight ??= base()
      .then((c) => {
        value = c;
        return c;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

function describeAssumeFailure(roleArn: string, e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  const name = (e as { name?: string })?.name ?? '';
  const denied = /AccessDenied|not authorized/i.test(`${name} ${msg}`);
  return (
    `cannot assume role ${roleArn} (--assume-role): ${msg}` +
    (denied
      ? ' — the calling identity needs sts:AssumeRole on this role, and the trust policy of the role must allow that identity'
      : '')
  );
}

// One provider per RESOLVED ARN and STS region for the whole run (not per client, not per
// stack): every stack of one account and region shares a session. The region is part of the
// key because fromTemporaryCredentials pins its STS client to the region it is built with —
// keyed by ARN alone, a first stack in a region STS cannot serve (an opt-in region not
// enabled for the caller) would fail every later stack of that ARN in any region.
const providers = new Map<string, CredentialProvider>();

function providerFor(roleArn: string, region: string, verb: Verb): CredentialProvider {
  const key = `${roleArn}|${region}`;
  let p = providers.get(key);
  if (!p) {
    const assume = fromTemporaryCredentials({
      params: { RoleArn: roleArn, RoleSessionName: `cdkrd-${verb}` },
      // The SOURCE identity is the ambient chain (env / --profile per #954), never
      // CLIENT_CREDENTIALS — inside a scope that would be this very provider.
      masterCredentials: AMBIENT_CREDENTIALS,
      clientConfig: { region, requestHandler: clientRequestHandler() },
    });
    const memo = memoizeCredentials(async () => {
      try {
        return await assume();
      } catch (e) {
        throw new AssumeRoleError(describeAssumeFailure(roleArn, e));
      }
    });
    p = () => memo();
    providers.set(key, p);
  }
  return p;
}

// The ambient identity's account, for a `{account}` placeholder on an env-agnostic stack
// (no `env.account` in the assembly) — the account such a stack deploys to under these
// credentials, as cdk itself resolves it. Resolved once per run with the AMBIENT
// credentials explicitly (never a previous stack's assumed role).
let ambientAccount: Promise<string | undefined> | undefined;

async function resolveAmbientAccount(region: string): Promise<string | undefined> {
  ambientAccount ??= (async () => {
    try {
      const sts = new STSClient({ region, ...CLIENT_TIMEOUTS, credentials: AMBIENT_CREDENTIALS });
      return (await sts.send(new GetCallerIdentityCommand({}))).Account;
    } catch {
      return undefined;
    }
  })();
  const account = await ambientAccount;
  // like the provider memo: a failure is not cached, so one transient STS error does not
  // fail every later env-agnostic stack of the run
  if (account === undefined) ambientAccount = undefined;
  return account;
}

const failing = (roleArn: string, error: Error): RoleScope => ({
  roleArn,
  // Fail CLOSED: anything that still resolves credentials inside a failed scope gets the
  // same error, never the ambient identity.
  provider: () => Promise.reject(error),
  error,
});

/**
 * Build the `--assume-role` scope for ONE stack. `undefined` when the flag is not set (the
 * verb then runs exactly as before, on the ambient credentials). Never throws: a failure is
 * carried on `scope.error`, which `enterRoleScope` raises after entering the scope.
 */
export async function stackRoleScope(
  template: string | undefined,
  stack: { account: string | undefined; region: string },
  verb: Verb
): Promise<RoleScope | undefined> {
  if (template === undefined) return undefined;
  let account = stack.account;
  if (account === undefined && needsAccount(template)) {
    account = await resolveAmbientAccount(stack.region);
    if (account === undefined) {
      return failing(
        template,
        new AssumeRoleError(
          `cannot resolve {account} in --assume-role ${template}: the stack has no env.account ` +
            `and sts:GetCallerIdentity failed for the calling identity`
        )
      );
    }
  }
  const roleArn = resolveAssumeRoleArn(template, account ?? '', stack.region);
  const provider = providerFor(roleArn, stack.region, verb);
  try {
    await provider();
  } catch (e) {
    return failing(roleArn, e instanceof Error ? e : new AssumeRoleError(String(e)));
  }
  return { roleArn, provider };
}

/**
 * Enter `scope` for the rest of the calling stack iteration (AsyncLocalStorage.enterWith,
 * so the verb's loop body needs no restructuring), then throw its error if the role could
 * not be assumed. A no-op for `undefined` (no `--assume-role`). Call it SYNCHRONOUSLY in the
 * loop body — entering inside an awaited helper would not reach the caller's continuation.
 */
export function enterRoleScope(scope: RoleScope | undefined): void {
  if (scope === undefined) return;
  roleScope.enterWith(scope);
  if (scope.error) throw scope.error;
}

/** Drop the per-run memo state. Test seam. */
export function resetAssumeRoleState(): void {
  providers.clear();
  ambientAccount = undefined;
}

// #1309: the #740 cross-account mismatch gate, shared by all four verbs.
//
// #1195 (#740) taught `check` to gate on a stack env-pinned (via `env.account`) to a
// DIFFERENT account than the active credentials: a pre-read `sts:GetCallerIdentity`
// vs `env.account` comparison, plus a post-read `desired.accountId` vs `env.account`
// belt-and-suspenders for when STS could not resolve the caller. But the gate lived
// inline in check.ts, so `record`, `ignore`, and `revert` ran UNGATED (#1309): with
// account-B credentials and a same-named stack deployed in B,
//   - `revert` (the one AWS-mutating verb) planned A-intent vs B-live and WROTE the
//     confirmed ops onto account B's resources — a wrong-account AWS write that
//     `checkBaselineAccount` cannot catch (no baseline exists for B),
//   - `record` snapshotted B's live values into a fresh
//     `<stack>.<B-account>.<region>.json` baseline as reviewed intent,
//   - `ignore` scoped rules to the wrong accountId,
// and without the same-named-stack coincidence all three misreported the pinned stack
// as "not deployed" instead of check's accurate cross-account skip.
//
// This module is the gate's shared home. check.ts re-exports the primitives it always
// used (`resolveCallerAccount`, `classifyAccountMismatch`) so its behavior — and the
// import surface existing tests pin — is unchanged; record/ignore/revert gate through
// `createAccountGate`. A proven mismatch is a SKIP for check/record/ignore (a
// multi-account app is operated one account at a time, so the other account's stack
// is simply out of reach for this run) and a per-stack ERROR (exit 2) for `revert` —
// the user explicitly asked to MUTATE that stack, so silently not doing so would read
// as "nothing to revert".
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { CLIENT_TIMEOUTS } from '../read/client-config.js';

export interface AccountMismatch {
  skip: boolean;
  message: string;
}

// The verb whose loop is gating — it only shapes the message tail: how the user is
// told to redo the operation ("… credentials to record it"), and, for `revert`, the
// refusal framing (an error, not a skip).
export type AccountGateVerb = 'check' | 'record' | 'ignore' | 'revert';

// The shared "what to do about it" tail. check/record/ignore skip; revert REFUSES —
// same fact, but the caller surfaced it as an error (#1309).
function mismatchTail(declaredAccount: string, verb: AccountGateVerb): string {
  return verb === 'revert'
    ? `refusing to revert (run with account-${declaredAccount} credentials to revert it)`
    : `skipped (run with account-${declaredAccount} credentials to ${verb} it)`;
}

/**
 * #1046: resolve the CURRENT account (region-free `sts:GetCallerIdentity`, a zero-permission
 * call) so `hasBaselineForStack` can pin the baseline filename's account segment. Returns
 * `undefined` on ANY failure (expired creds, blocked STS, network) so the caller falls back
 * to today's account-wildcard rather than erroring — a `check` that reached the not-deployed
 * catch already has working creds, so the STS call almost always succeeds. `--profile` is
 * already in `process.env.AWS_PROFILE` (set by the verb entry points), so the default
 * credential chain resolves it. Exported for unit tests (moved here from check.ts, #1309).
 */
export async function resolveCallerAccount(region: string): Promise<string | undefined> {
  try {
    const sts = new STSClient({ region, ...CLIENT_TIMEOUTS });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    return id.Account;
  } catch {
    return undefined;
  }
}

/**
 * #740: decide whether a stack must be SKIPPED because it is pinned (via `env.account`) to a
 * different AWS account than the active credentials are for.
 *
 * A CDK app with dev+prod stacks in DIFFERENT accounts (the CDK Pipelines / multi-env staple)
 * is checked one account at a time — the caller runs `check --all` per account with that
 * account's credentials. A stack whose `env.account` names an OTHER account cannot be read
 * with the current creds: `DescribeStacks` throws "does not exist" (the stack IS deployed, just
 * in its own account), which `isStackNotDeployed` mistakes for "never deployed yet — skipped"
 * — a misleading green pass that hides an UNCHECKED stack. Worse, if a SAME-NAMED stack happens
 * to exist in the reachable account, cdkrd would silently compare intent against the WRONG
 * account's live resources. Detecting the mismatch UP FRONT lets each verb act accurately
 * without reading the wrong account.
 *
 * Rule: skip ONLY when BOTH accounts are known (concrete) AND they differ — a proven mismatch.
 * When either is undefined (an env-agnostic stack with no account pin, or STS could not resolve
 * the caller) we CANNOT prove a mismatch, so we do NOT skip — behavior is identical to today
 * (the stack is read; a real "not deployed" still surfaces as before). `verb` only shapes the
 * message tail (#1309); the default keeps check's message byte-identical. Pure (no AWS) +
 * exported for unit tests (moved here from check.ts, #1309).
 */
export function classifyAccountMismatch(
  declaredAccount: string | undefined,
  callerAccount: string | undefined,
  verb: AccountGateVerb = 'check'
): AccountMismatch {
  if (declaredAccount && callerAccount && declaredAccount !== callerAccount) {
    return {
      skip: true,
      message: `stack is pinned to account ${declaredAccount} but the active credentials are for account ${callerAccount} — ${mismatchTail(declaredAccount, verb)}`,
    };
  }
  return { skip: false, message: '' };
}

/**
 * #740 (belt-and-suspenders for case 2): the pre-read gate above skips a proven
 * cross-account mismatch, but if the caller account could not be resolved (STS blocked)
 * it lets the read proceed — and a SAME-NAMED stack in the reachable account would then
 * be compared against the WRONG account. After the read the deployed stack's account IS
 * known (`desired.accountId`); if this stack is pinned to a concrete account that differs,
 * the live state just read is the wrong account's — the verb must not trust it (report /
 * record / ignore / write against it). Defense-in-depth; the pre-read gate covers the
 * common case where the caller account IS known. Extracted from check.ts's inline guard
 * (#1309) so record/ignore/revert apply the identical rule; the default `verb` keeps
 * check's message byte-identical. Pure (no AWS) + exported for unit tests.
 */
export function classifyReadAccountMismatch(
  declaredAccount: string | undefined,
  readAccountId: string,
  verb: AccountGateVerb = 'check'
): AccountMismatch {
  if (declaredAccount && readAccountId !== declaredAccount) {
    return {
      skip: true,
      message: `compared against account ${readAccountId} but the stack is pinned to ${declaredAccount} — ${mismatchTail(declaredAccount, verb)}`,
    };
  }
  return { skip: false, message: '' };
}

export interface AccountGate {
  // The pre-read gate: resolve the caller account (at most once per run, lazily — the
  // STS call is made only when this stack IS account-pinned, so an env-agnostic app
  // never pays it) and classify against the stack's env.account. Call BEFORE the gather
  // so the wrong account is never even read.
  preRead: (declaredAccount: string | undefined, region: string) => Promise<AccountMismatch>;
  // The post-read guard: classify the gather's resolved accountId against the stack's
  // env.account. Call AFTER the gather, BEFORE anything consumes the live state.
  postRead: (declaredAccount: string | undefined, readAccountId: string) => AccountMismatch;
}

/**
 * #1309: one per-run gate instance for a verb's stack loop. Mirrors check.ts's one-shot
 * caller-account resolution (`sts:GetCallerIdentity` is region-free — the account is the
 * same across regions — so the first answer is cached for every subsequent stack), but
 * LAZILY: the STS call only happens for a stack that actually carries an `env.account`
 * pin. An `undefined` cached answer (STS failed) is remembered too — the post-read guard
 * is the backstop for that case, exactly as in check.
 */
export function createAccountGate(verb: AccountGateVerb): AccountGate {
  let callerAccount: string | undefined;
  let callerAccountResolved = false;
  return {
    preRead: async (declaredAccount, region) => {
      // No env.account pin → no mismatch can be proven; skip the STS call entirely.
      if (!declaredAccount) return { skip: false, message: '' };
      if (!callerAccountResolved) {
        callerAccount = await resolveCallerAccount(region);
        callerAccountResolved = true;
      }
      return classifyAccountMismatch(declaredAccount, callerAccount, verb);
    },
    postRead: (declaredAccount, readAccountId) =>
      classifyReadAccountMismatch(declaredAccount, readAccountId, verb),
  };
}

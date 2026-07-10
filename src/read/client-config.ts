// Shared AWS SDK client retry config for cdkrd's READ path — applied to EVERY
// read-side client: the Cloud Control / CloudFormation clients in gather.ts, all
// SDK-override clients in overrides.ts, AND the KMS client in kms-aliases.ts.
// `check` reads every resource in a stack with bounded concurrency (gather.ts POOL_SIZE), which on a
// large stack (hundreds of resources) drives Cloud Control GetResource /
// CloudFormation describe-type / the SDK-override APIs straight into
// ThrottlingException. The SDK default (`standard` mode, maxAttempts=3) is not
// enough headroom, so a throttled read was being reported as `skipped` — silent
// coverage loss + noise. `adaptive` mode adds a client-side rate limiter (it backs
// off the whole client when it sees throttling) and a higher attempt budget rides
// out transient throttles. Reads are idempotent, so retrying is always safe.
// Connection + per-request timeouts for EVERY cdkrd AWS client (#1066). Without them the
// AWS SDK v3 default handler waits INDEFINITELY: a stalled TCP connect (a blackholed
// endpoint, a security-group/NACL drop, a hung proxy) or a connected-but-silent server
// hangs `check`/`record`/`revert` FOREVER — in CI the job only dies at the runner's global
// timeout. `connectionTimeout` bounds establishing the socket; `requestTimeout` bounds a
// single attempt end to end (generous so a legitimately slow API call is never cut, but a
// silent server can no longer hang a whole attempt). Passed as the NodeHttpHandler options
// object, which every AWS v3 client accepts and wraps. Applied to the READ clients via
// READ_RETRY below and spread directly into the revert WRITE clients (which must NOT inherit
// the read-path adaptive retry — a write is not idempotent).
import {
  createCredentialChain,
  fromEnv,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';

// #954: align the raw SDK clients' credential precedence with toolkit-lib / the AWS CLI.
//
// The split-brain: when BOTH static env credentials (AWS_ACCESS_KEY_ID +
// AWS_SECRET_ACCESS_KEY) AND AWS_PROFILE are set — and no explicit `--profile` — the two
// SDK stacks inside one cdkrd process pick OPPOSITE identities. toolkit-lib (synth /
// discovery / context) prepends `fromEnv()` to its chain (`shouldPrioritizeEnv()` in
// awscli-compatible.ts), so the ENV creds win over AWS_PROFILE. But the raw AWS SDK v3
// default provider does the reverse: when `AWS_PROFILE` is set it SKIPS `fromEnv` and uses
// the PROFILE creds. Result: discovery under account A, every live read / baseline / revert
// write under account B — silent cross-account divergence.
//
// Fix: give every raw client the SAME chain toolkit-lib uses. `shouldPrioritizeEnv()` below
// is a faithful port of toolkit-lib's function (same env vars + AMAZON_* backward-compat
// aliases). When env creds + AWS_PROFILE are both present, the chain is
// `createCredentialChain(fromEnv(), fromNodeProviderChain())` so ENV wins — exactly the
// toolkit-lib branch. Otherwise the chain is a plain `fromNodeProviderChain()`, which is
// the SDK's own default behavior, so single-source (env-only or profile-only) is unchanged.
//
// EXPLICIT `--profile`: toolkit-lib uses `fromIni({ profile })` EXCLUSIVELY (env does NOT
// win). `parseCommonArgs` (cli-args.ts) sets `CDKRD_EXPLICIT_PROFILE=1` when `--profile` is
// present, and the verb entry points export the resolved profile as `process.env.AWS_PROFILE`.
// We honor that marker by NOT prioritizing env in the explicit-profile case, so
// `fromNodeProviderChain` resolves the profile — matching toolkit-lib (both halves pick the
// profile, never env).
//
// The provider is a LAZY function: the SDK calls it at first-request time, AFTER the verb
// entry point has exported AWS_PROFILE / CDKRD_EXPLICIT_PROFILE, so the decision reads the
// final environment (not the module-load snapshot).

/** Port of toolkit-lib awscli-compatible `shouldPrioritizeEnv()` (env creds win over profile). */
export function shouldPrioritizeEnv(): boolean {
  // An explicit `--profile` means `fromIni(profile)` exclusively in toolkit-lib — env must
  // NOT win. The verb entry points mark this so both SDK stacks agree on the profile.
  if (process.env.CDKRD_EXPLICIT_PROFILE) return false;
  const id = process.env.AWS_ACCESS_KEY_ID || process.env.AMAZON_ACCESS_KEY_ID;
  const key = process.env.AWS_SECRET_ACCESS_KEY || process.env.AMAZON_SECRET_ACCESS_KEY;
  return !!id && !!key;
}

// The shared credential provider spread into EVERY raw SDK client (via CLIENT_TIMEOUTS /
// READ_RETRY). A single function reference is reused across all clients; it decides env-vs-
// profile precedence lazily on each resolution (see shouldPrioritizeEnv).
export const CLIENT_CREDENTIALS = (awsIdentityProperties?: Record<string, unknown>) =>
  (shouldPrioritizeEnv()
    ? createCredentialChain(fromEnv(), fromNodeProviderChain())
    : fromNodeProviderChain())(awsIdentityProperties);

export const CLIENT_TIMEOUTS = {
  credentials: CLIENT_CREDENTIALS,
  requestHandler: {
    connectionTimeout: 6_000, // 6s to establish the TCP connection (aborts the connect attempt)
    requestTimeout: 60_000, // 60s for a single request attempt (retries add their own budget)
    // REQUIRED to make requestTimeout actually ABORT a connected-but-silent server:
    // @smithy/node-http-handler's requestTimeout otherwise only logs a warning and keeps
    // waiting (backward-compat default), so the hang would persist. With this it rejects.
    throwOnRequestTimeout: true,
  },
};

export const READ_RETRY = {
  maxAttempts: 10,
  retryMode: 'adaptive' as const,
  ...CLIENT_TIMEOUTS,
};

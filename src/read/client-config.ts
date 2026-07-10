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
export const CLIENT_TIMEOUTS = {
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

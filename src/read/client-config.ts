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
export const READ_RETRY = {
  maxAttempts: 10,
  retryMode: 'adaptive' as const,
};

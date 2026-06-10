// Read source router (per resource TYPE):
//   CC API GetResource (default, auto-follows new types)
//   → SDK override readCurrentState (only CC-gap types from the deny list)
//   → skip + log (neither can read).
//
// Returns full live property model per resource; declared/undeclared labeling
// happens LATER (not here — that is a template-comparison concern).
//
// COPY from cdkd: provisioning/cloud-control-provider.ts readCurrentState,
//   analyzer/drift-cc-api-deny-list.ts, a few provider readCurrentState (s3/iam/lambda).

export interface ReadResult {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  live?: Record<string, unknown>; // undefined when skipped
  skippedReason?: string;
}

export async function readStack(
  _resources: ReadonlyArray<{ logicalId: string; resourceType: string; physicalId: string }>,
  _region: string,
): Promise<ReadResult[]> {
  // TODO(phase2): CC API default → SDK override → skip+log
  throw new Error('not implemented');
}

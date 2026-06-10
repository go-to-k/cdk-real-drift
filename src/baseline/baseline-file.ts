// NEW. Git-committed baseline file: .cdkdrift/<stack>.<region>.json
// Stores ONLY what has no other source of truth: undeclared/watched property
// values + ignore globs + meta. Declared desired comes live from GetTemplate, so
// it is NOT stored here. Secrets (writeOnly) are never read back, so never stored.

export interface BaselineFile {
  schemaVersion: 1;
  stackName: string;
  region: string;
  capturedAt: string;
  templateHash: string; // deployed template hash at capture (skew detection)
  watched: Record<string, { type: string; physicalId: string; props: Record<string, unknown> }>;
  packOverrides?: Record<string, Record<string, unknown>>;
  ignore?: string[];
}

export function baselinePath(stack: string, region: string): string {
  return `.cdkdrift/${stack}.${region}.json`;
}

export async function loadBaseline(_stack: string, _region: string): Promise<BaselineFile | undefined> {
  // TODO(phase2): read + parse; undefined if absent (check still runs declared-only)
  throw new Error('not implemented');
}

export async function writeBaseline(_b: BaselineFile): Promise<void> {
  // TODO(phase2): write JSON (stable key order for clean PR diffs)
  throw new Error('not implemented');
}

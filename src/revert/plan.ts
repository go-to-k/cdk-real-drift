// Build a revert plan from drift findings (pure — no AWS). Revert writes the
// DESIRED value back to AWS:
//   declared drift   -> the deployed-template value (finding.desired)
//   undeclared drift -> the baseline value if blessed before (restore), else REMOVE
//   removed-undeclared (blessed value gone) -> re-add the baseline value
// Not revertable: readGap / unresolved / skipped, and (v1) the SDK-override
// CC-gap types (revert for those is a follow-up).
import type { BaselineFile } from '../baseline/baseline-file.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import type { Finding } from '../types.js';
import { SDK_WRITERS } from './writers.js';

export interface PatchOp {
  op: 'add' | 'remove';
  path: string; // RFC6902 JSON pointer into the resource Properties model
  value?: unknown;
  human: string; // one-line description for the plan display
}

export interface RevertItem {
  logicalId: string;
  displayId: string; // construct path or logical id
  resourceType: string;
  physicalId: string;
  kind: 'cc' | 'sdk'; // cc = Cloud Control UpdateResource; sdk = type-specific SDK writer
  ops: PatchOp[];
}

export interface NotRevertable {
  displayId: string;
  resourceType: string;
  path: string;
  reason: string;
}

export interface RevertPlan {
  items: RevertItem[];
  notRevertable: NotRevertable[];
}

// dotted finding path ("A.B.0.C") -> RFC6902 JSON pointer ("/A/B/0/C")
function toPointer(dotted: string): string {
  return (
    '/' +
    dotted
      .split('.')
      .map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

const DRIFT_TIERS = new Set(['declared', 'undeclared']);

export function buildRevertPlan(
  findings: Finding[],
  baseline: BaselineFile | undefined
): RevertPlan {
  const itemsByLogical = new Map<string, RevertItem>();
  const notRevertable: NotRevertable[] = [];
  const blessed = baseline?.accepted ?? [];

  for (const f of findings) {
    const displayId = f.constructPath ?? f.logicalId;
    if (f.tier === 'deleted') {
      // a resource deleted out of band cannot be patched back — it must be
      // recreated by re-deploying the stack.
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'deleted — recreate via cdk deploy',
      });
      continue;
    }
    if (!DRIFT_TIERS.has(f.tier)) continue; // only declared/undeclared are drift to revert
    if (!f.physicalId) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'no physical id',
      });
      continue;
    }
    // CC-gap types are revertable only when we have a type-specific SDK writer
    if (SDK_OVERRIDES[f.resourceType] && !SDK_WRITERS[f.resourceType]) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'type not revertable yet',
      });
      continue;
    }
    const kind: RevertItem['kind'] = SDK_WRITERS[f.resourceType] ? 'sdk' : 'cc';

    const op = revertOp(f, blessed);
    const item =
      itemsByLogical.get(f.logicalId) ??
      ({
        logicalId: f.logicalId,
        displayId,
        resourceType: f.resourceType,
        physicalId: f.physicalId,
        kind,
        ops: [],
      } as RevertItem);
    item.ops.push(op);
    itemsByLogical.set(f.logicalId, item);
  }

  return { items: [...itemsByLogical.values()], notRevertable };
}

function revertOp(f: Finding, blessed: BaselineFile['accepted']): PatchOp {
  const pointer = toPointer(f.path);
  if (f.tier === 'declared') {
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> deployed-template value`,
    };
  }
  // undeclared: blessed before? restore that value; else it is a new addition -> remove
  const wasBlessed = blessed.find((a) => a.logicalId === f.logicalId && a.path === f.path);
  if (f.actual === undefined && f.desired !== undefined) {
    // removed-undeclared finding: re-add the blessed value
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> restore blessed value`,
    };
  }
  if (wasBlessed) {
    return {
      op: 'add',
      path: pointer,
      value: wasBlessed.value,
      human: `${f.path} -> blessed value`,
    };
  }
  return {
    op: 'remove',
    path: pointer,
    human: `${f.path} -> remove (undeclared, not in baseline)`,
  };
}

/** Serialize a RevertItem's ops to an RFC6902 PatchDocument string for Cloud Control. */
export function toPatchDocument(item: RevertItem): string {
  return JSON.stringify(
    item.ops.map(({ op, path, value }) => (op === 'remove' ? { op, path } : { op, path, value }))
  );
}

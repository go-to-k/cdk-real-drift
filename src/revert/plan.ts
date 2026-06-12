// Build a revert plan from drift findings (pure — no AWS). Revert writes the
// DESIRED value back to AWS:
//   declared drift   -> the deployed-template value (finding.desired)
//   undeclared drift -> the baseline value if accepted before (restore), else REMOVE
//   removed-undeclared (baseline value gone) -> re-add the baseline value
// Not revertable: readGap / unresolved / skipped, and (v1) the SDK-override
// CC-gap types (revert for those is a follow-up).
import type { BaselineFile } from '../baseline/baseline-file.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import type { Finding, SchemaInfo } from '../types.js';
import { SDK_PROP_WRITERS, SDK_WRITERS } from './writers.js';

export interface PatchOp {
  op: 'add' | 'remove';
  path: string; // RFC6902 JSON pointer into the resource Properties model
  value?: unknown;
  // the finding's CURRENT live value, for property-scoped SDK writers that revert
  // per entry (e.g. IAM Role inline Policies). Never serialized to Cloud Control
  // (toPatchDocument picks op/path/value only).
  prior?: unknown;
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

export interface RevertOptions {
  // (revert) when no baseline file exists, undeclared drift is removed only if this
  // is set. Without it, undeclared drift on an unaccepted stack is reported as
  // notRevertable (a bulk REMOVE of every undeclared value that slipped through
  // noise subtraction would be destructive — fail-safe instead).
  removeUnaccepted?: boolean;
  // resourceType -> schema, so create-only property drift is reported as
  // notRevertable up front (an in-place patch would fail at apply time).
  schemas?: Map<string, SchemaInfo>;
}

// the first dotted segment of a finding path ("A.B.0" -> "A"), used to test the
// top-level create-only set.
function topSegment(path: string): string {
  return path.split('.')[0] ?? path;
}

export function buildRevertPlan(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  opts: RevertOptions = {}
): RevertPlan {
  const itemsByLogical = new Map<string, RevertItem>();
  const notRevertable: NotRevertable[] = [];
  const accepted = baseline?.accepted ?? [];
  // "the stack has never been `accept`ed" — undeclared removal is gated on this.
  const noBaseline = baseline === undefined;

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
    // unaccepted undeclared drift: a no-baseline stack would otherwise REMOVE every
    // such value (the subtractive model's failure mode is "check is noisy", but the
    // revert mirror of that is destructive). Refuse unless --remove-unaccepted.
    // Evaluated BEFORE the create-only guard (R35): on a no-baseline stack the
    // fundamental blocker for undeclared drift is "no revert target exists", and the
    // right next step is `accept` (which records the value into the baseline,
    // making it no longer drift) — a "requires replacement" reason would
    // mis-direct the user.
    if (
      f.tier === 'undeclared' &&
      noBaseline &&
      !opts.removeUnaccepted &&
      !(f.actual === undefined && f.desired !== undefined) // a removed-baseline-value re-add can't occur without a baseline, but be explicit
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'no baseline — run `cdkrd accept` first, or pass --remove-unaccepted',
      });
      continue;
    }
    // create-only property: an in-place UpdateResource patch would be rejected (the
    // change needs a replacement) — report it now instead of failing at apply time.
    if (opts.schemas?.get(f.resourceType)?.createOnly.has(topSegment(f.path))) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'create-only property — change requires resource replacement',
      });
      continue;
    }
    // property-scoped SDK writers match the EXACT top-level finding path only
    // (deeper paths keep going through Cloud Control); a resource can therefore
    // split into one cc item and one sdk item per scoped path — key the grouping
    // by kind (+ path when prop-scoped) so each item resolves to ONE writer.
    const propScoped =
      !SDK_WRITERS[f.resourceType] && SDK_PROP_WRITERS[f.resourceType]?.[f.path] !== undefined;
    const kind: RevertItem['kind'] = SDK_WRITERS[f.resourceType] || propScoped ? 'sdk' : 'cc';

    const op = revertOp(f, accepted);
    const key = `${f.logicalId} ${kind}${propScoped ? ` ${f.path}` : ''}`;
    const item =
      itemsByLogical.get(key) ??
      ({
        logicalId: f.logicalId,
        displayId,
        resourceType: f.resourceType,
        physicalId: f.physicalId,
        kind,
        ops: [],
      } as RevertItem);
    item.ops.push(op);
    itemsByLogical.set(key, item);
  }

  return { items: [...itemsByLogical.values()], notRevertable };
}

function revertOp(f: Finding, accepted: BaselineFile['accepted']): PatchOp {
  const pointer = toPointer(f.path);
  if (f.tier === 'declared') {
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> deployed-template value`,
    };
  }
  // undeclared: accepted before? restore that value; else it is a new addition -> remove.
  // `prior` carries the finding's current live value for property-scoped SDK
  // writers (per-entry revert); Cloud Control serialization ignores it.
  const wasAccepted = accepted.find((a) => a.logicalId === f.logicalId && a.path === f.path);
  if (f.actual === undefined && f.desired !== undefined) {
    // removed-undeclared finding: re-add the baseline value
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> restore baseline value`,
    };
  }
  if (wasAccepted) {
    return {
      op: 'add',
      path: pointer,
      value: wasAccepted.value,
      prior: f.actual,
      human: `${f.path} -> baseline value`,
    };
  }
  return {
    op: 'remove',
    path: pointer,
    prior: f.actual,
    human: `${f.path} -> remove (undeclared, not in baseline)`,
  };
}

/** Serialize a RevertItem's ops to an RFC6902 PatchDocument string for Cloud Control. */
export function toPatchDocument(item: RevertItem): string {
  return JSON.stringify(
    item.ops.map(({ op, path, value }) => (op === 'remove' ? { op, path } : { op, path, value }))
  );
}

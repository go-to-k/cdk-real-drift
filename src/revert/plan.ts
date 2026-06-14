// Build a revert plan from drift findings (pure — no AWS). Revert writes the
// DESIRED value back to AWS:
//   declared drift   -> the deployed-template value (finding.desired)
//   undeclared drift -> the baseline value if accepted before (restore), else
//                       REMOVE (the value appeared since a snapshot-complete accept)
//   removed-undeclared (baseline value gone) -> re-add the baseline value
// UNRECORDED values (R62: no baseline entry, resource never snapshot-complete)
// are not drift and have no revert target — notRevertable unless
// --remove-unaccepted explicitly turns them into REMOVE ops.
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
  // R78: the Key of a changed attribute inside an ELB attribute bag. Set only for
  // attribute-bag findings; the SDK writer sends `{Key, Value: value}` via
  // ModifyLoadBalancerAttributes. Never serialized to Cloud Control.
  attributeKey?: string;
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
  // UNRECORDED undeclared values are removed only if this is set. Without it they
  // are reported as notRevertable (a bulk REMOVE of every undecided value that
  // slipped through noise subtraction would be destructive — fail-safe instead).
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
    // Nested undeclared values (R96/R98) are detect/accept-only, NOT revertable. Their
    // path addresses a sub-key INSIDE a declared object or array element — dotted
    // (`Conf.Destination`) or, for an identity-keyed array element, `Prop[<id>].sub`.
    // `toPointer` builds a flat RFC6902 pointer by splitting on '.', so the bracket
    // form yields the malformed `/Prop[<id>]/sub` (the bracket is not RFC6902 and the
    // CC patch would target a literal key, not the array element). Even the dotted form
    // is a fragile deep patch (the same reason R78 abandoned index-based array patches).
    // These are overwhelmingly AWS-materialized defaults — report + baseline them, and
    // fix any real divergence in your IaC or by re-accepting the live value. Detect by
    // PATH SHAPE, not Finding.nested: a baseline value REMOVED since accept is
    // reconstructed (baseline-file.ts) WITHOUT the flag, but keeps its nested path. A
    // top-level undeclared path is a single key (never contains '.'/'['), and declared
    // drift is a different tier — so this never blocks a top-level revert.
    if (f.tier === 'undeclared' && (f.nested || f.path.includes('.') || f.path.includes('['))) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'nested undeclared value — detect/accept only, not revertable',
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
    // UNRECORDED values (R62): the user never decided on them, so a default plan
    // would otherwise REMOVE every such value (the subtractive model's failure
    // mode is "check is noisy", but the revert mirror of that is destructive).
    // Refuse unless --remove-unaccepted. Evaluated BEFORE the create-only guard
    // (R35): the fundamental blocker is "no revert target exists".
    // The reason wording is a FORK, not a sequence (R55): "accept first, then
    // revert" reads as if accept were a step toward reverting THESE values, but
    // accepting them endorses them (they leave the report entirely) — accept is
    // for values that are RIGHT; --remove-unaccepted is for values that are WRONG.
    if (f.tier === 'undeclared' && f.unrecorded && !opts.removeUnaccepted) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'unrecorded — accept it if the live value is right, or --remove-unaccepted to remove it',
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
      ...(f.attributeKey !== undefined && { attributeKey: f.attributeKey }),
      human: `${f.path}${f.attributeKey ? `[${f.attributeKey}]` : ''} -> deployed-template value`,
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

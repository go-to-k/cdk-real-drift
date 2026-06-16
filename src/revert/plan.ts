// Build a revert plan from drift findings (pure — no AWS). Revert writes the
// DESIRED value back to AWS:
//   declared drift   -> the deployed-template value (finding.desired)
//   undeclared drift -> the baseline value if recorded before (restore), else
//                       REMOVE (the value appeared since a snapshot-complete record)
//   removed-undeclared (baseline value gone) -> re-add the baseline value
// UNRECORDED values (R62: no baseline entry, resource never snapshot-complete)
// are not drift and have no revert target — notRevertable unless
// --remove-unrecorded explicitly turns them into REMOVE ops.
// Not revertable: readGap / unresolved / skipped, and (v1) the SDK-override
// CC-gap types (revert for those is a follow-up).
import type { BaselineFile } from '../baseline/baseline-file.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import { awsManagedTags } from '../normalize/noise.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import type { Finding, SchemaInfo } from '../types.js';
import { SDK_PROP_WRITERS, SDK_WRITERS } from './writers.js';

/**
 * A nested undeclared value (a live sub-key inside a declared object, R96/R98) is
 * detect/record-only — never revertable (toPointer can't build a safe RFC6902 patch for
 * a dotted/bracketed path; R99). Detected by PATH SHAPE, not just `Finding.nested`: a
 * baseline value removed since record is reconstructed without the flag but keeps its
 * nested path. A top-level undeclared path is a single key (no '.'/'['). Pure + exported
 * so the interactive action picker offers `revert` ONLY where revert can actually run.
 */
export function isNestedUndeclared(f: Finding): boolean {
  return (
    f.tier === 'undeclared' && (Boolean(f.nested) || f.path.includes('.') || f.path.includes('['))
  );
}

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
  // cc = Cloud Control UpdateResource; sdk = type-specific SDK writer;
  // delete = Cloud Control DeleteResource (revert of an `added` out-of-band resource).
  kind: 'cc' | 'sdk' | 'delete';
  ops: PatchOp[]; // for `delete`: a single pseudo-op carrying the human label (never serialized)
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
  removeUnrecorded?: boolean;
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
  const recorded = baseline?.recorded ?? [];

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
    if (f.tier === 'added') {
      // an out-of-band resource (not in the template) is reverted by DELETING it via
      // Cloud Control DeleteResource. f.physicalId is the CC identifier (the composite
      // `RestApiId|ResourceId[|HttpMethod]`). Modeled as a `delete`-kind item carrying a
      // single pseudo-op so the picker / count / filter machinery (which is op-based)
      // works unchanged; the apply path branches on kind and never serializes the op.
      if (!f.physicalId) {
        notRevertable.push({
          displayId,
          resourceType: f.resourceType,
          path: f.path,
          reason: 'no physical id',
        });
        continue;
      }
      itemsByLogical.set(f.logicalId, {
        logicalId: f.logicalId,
        displayId,
        resourceType: f.resourceType,
        physicalId: f.physicalId,
        kind: 'delete',
        ops: [
          {
            op: 'remove',
            path: '',
            human: `DELETE out-of-band ${f.resourceType} (not in your template)`,
          },
        ],
      });
      continue;
    }
    // Nested undeclared values (R96/R98) are detect/record-only, NOT revertable. Their
    // path addresses a sub-key INSIDE a declared object or array element — dotted
    // (`Conf.Destination`) or, for an identity-keyed array element, `Prop[<id>].sub`.
    // `toPointer` builds a flat RFC6902 pointer by splitting on '.', so the bracket
    // form yields the malformed `/Prop[<id>]/sub` (the bracket is not RFC6902 and the
    // CC patch would target a literal key, not the array element). Even the dotted form
    // is a fragile deep patch (the same reason R78 abandoned index-based array patches).
    // These are overwhelmingly AWS-materialized defaults — report + baseline them, and
    // fix any real divergence in your IaC or by re-recording the live value. Detect by
    // PATH SHAPE, not Finding.nested: a baseline value REMOVED since record is
    // reconstructed (baseline-file.ts) WITHOUT the flag, but keeps its nested path. A
    // top-level undeclared path is a single key (never contains '.'/'['), and declared
    // drift is a different tier — so this never blocks a top-level revert.
    if (isNestedUndeclared(f)) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'nested undeclared value — detect/record only, not revertable',
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
    // Refuse unless --remove-unrecorded. Evaluated BEFORE the create-only guard
    // (R35): the fundamental blocker is "no revert target exists".
    // The reason wording is a FORK, not a sequence (R55): "record first, then
    // revert" reads as if record were a step toward reverting THESE values, but
    // recording them endorses them (they leave the report entirely) — record is
    // for values that are RIGHT; --remove-unrecorded is for values that are WRONG.
    if (f.tier === 'undeclared' && f.unrecorded && !opts.removeUnrecorded) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'unrecorded — record it if the live value is right, or --remove-unrecorded to remove it',
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

    const op = revertOp(f, recorded);
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

function revertOp(f: Finding, recorded: BaselineFile['recorded']): PatchOp {
  const pointer = toPointer(f.path);
  if (f.tier === 'declared') {
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      // Carry the current live value as `prior`, exactly like the undeclared branches
      // below. A property-scoped SDK writer that reverts PER ENTRY needs it:
      // `writeIamRoleInlinePolicies` deletes every inline policy present in `prior`
      // that the declared `value` no longer keeps. Without `prior` a declared
      // `/Policies` drift (a rogue inline policy added out of band → whole-array drift)
      // would re-PUT the declared policies but NEVER delete the rogue one — a silent,
      // security-relevant incomplete revert. Cloud Control serialization ignores
      // `prior`, and the ELB attribute-bag writers key off `attributeKey`, so this is
      // inert for them.
      prior: f.actual,
      ...(f.attributeKey !== undefined && { attributeKey: f.attributeKey }),
      human: `${f.path}${f.attributeKey ? `[${f.attributeKey}]` : ''} -> deployed-template value`,
    };
  }
  // undeclared: recorded before? restore that value; else it is a new addition -> remove.
  // `prior` carries the finding's current live value for property-scoped SDK
  // writers (per-entry revert); Cloud Control serialization ignores it.
  const wasRecorded = recorded.find((a) => a.logicalId === f.logicalId && a.path === f.path);
  if (f.actual === undefined && f.desired !== undefined) {
    // removed-undeclared finding: re-add the baseline value
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> restore baseline value`,
    };
  }
  if (wasRecorded) {
    return {
      op: 'add',
      path: pointer,
      value: wasRecorded.value,
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

// Cloud Control applies an UpdateResource patch read-modify-write: it reads the
// current model, applies the patch, and hands the result to the provider's update
// handler. Read handlers CANNOT return write-only properties, so any write-only
// property absent from the patch vanishes from the desired state on every CC-routed
// update (cdkd #812). For most types the loss is silent; some hard-fail — e.g.
// reverting any property on an AWS::ECS::Service with a managed EBS volume drops the
// write-only `VolumeConfigurations` and UpdateService rejects with "Task definition
// has configuredAtLaunch volume but no volume configuration provided at runtime".
//
// Re-include every TOP-LEVEL write-only property present (and fully resolved) in the
// declared model that the patch does not already touch — restoring the CC
// read-modify-write contract. Only `cc`-kind items need this (SDK writers don't
// read-modify-write through Cloud Control). An UNRESOLVED declared value is skipped
// (we cannot send a sentinel); the patch then omits it exactly as before, so this
// never makes a borderline revert WORSE than today.
export function writeOnlyReincludeOps(
  declared: Record<string, unknown> | undefined,
  schema: SchemaInfo | undefined,
  existingOps: PatchOp[]
): PatchOp[] {
  if (!declared || !schema || schema.writeOnly.size === 0) return [];
  const touched = new Set(existingOps.map((o) => o.path));
  const ops: PatchOp[] = [];
  for (const k of Object.keys(declared)) {
    if (!schema.writeOnly.has(k)) continue;
    const pointer = toPointer(k);
    if (touched.has(pointer)) continue;
    const value = declared[k];
    if (value === UNRESOLVED || hasUnresolved(value)) continue;
    ops.push({
      op: 'add',
      path: pointer,
      value,
      human: `${k} -> re-include write-only (Cloud Control read-modify-write contract)`,
    });
  }
  return ops;
}

// Cloud Control applies a `/Tags` patch read-modify-write: it reads the live model
// (which AWS augments with `aws:cloudformation:*` / `aws:*` managed tags), applies the
// patch, then hands the result to the provider's update handler. The handler diffs the
// resulting tag set against the live set and UNtags whatever is gone — so a bare
// `remove /Tags` (or an `add /Tags` whose value omits the managed tags) tells the
// provider to drop the `aws:*` tags too, which AWS hard-rejects: "aws: prefixed tag key
// names are not allowed for external use" (reproduced live reverting an out-of-band tag
// on an AWS::SNS::Topic). cdkrd strips `aws:*` tags from the COMPARE side
// (stripAwsTagsDeep), so the finding value never carries them; the revert must re-attach
// them on the WRITE side. For any cc-kind op on the top-level `/Tags` pointer, rewrite it
// to an `add /Tags` whose value is the intended user tags MERGED WITH the live `aws:*`
// tags — so the provider leaves the managed tags untouched and only the user tag changes.
// A `remove` becomes `add []`-of-managed-only; an `add` keeps its value plus the managed
// tags. With no managed tags present (or no live model) the op is returned unchanged, so
// this never alters a tag revert that wasn't at risk. Only `/Tags` LIST-shaped values are
// handled (the {Key,Value}[] shape awsManagedTags understands); nested tag paths are
// already not-revertable (isNestedUndeclared), so only the top-level pointer can appear.
const TAGS_POINTER = '/Tags';
function asTagList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function tagPreservingOps(
  ops: PatchOp[],
  liveRaw: Record<string, unknown> | undefined
): PatchOp[] {
  const managed = awsManagedTags(liveRaw?.['Tags']);
  if (managed.length === 0) return ops; // nothing managed to protect — leave ops as-is
  return ops.map((op) => {
    if (op.path !== TAGS_POINTER) return op;
    // user (non-managed) tags the revert wants to KEEP: an `add` keeps its value's
    // tags, a `remove` keeps none — either way, drop any aws:* entry from the value
    // (it should never carry one, but be defensive — same per-element predicate as
    // awsManagedTags) and re-attach the live managed set.
    const userTags =
      op.op === 'add' ? asTagList(op.value).filter((t) => awsManagedTags([t]).length === 0) : [];
    return {
      op: 'add',
      path: TAGS_POINTER,
      value: [...userTags, ...managed],
      ...(op.prior !== undefined && { prior: op.prior }),
      human: `${op.human} (preserving aws:* managed tags)`,
    };
  });
}

/** Serialize a RevertItem's ops to an RFC6902 PatchDocument string for Cloud Control. */
export function toPatchDocument(item: RevertItem): string {
  return JSON.stringify(
    item.ops.map(({ op, path, value }) => (op === 'remove' ? { op, path } : { op, path, value }))
  );
}

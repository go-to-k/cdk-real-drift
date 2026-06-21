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

// SDK-override types that are nonetheless Cloud Control FULLY_MUTABLE — their override
// exists only to work around a READ quirk, NOT because CC cannot UPDATE them, so a CC
// UpdateResource revert is valid and they are EXEMPT from the "read-override => not
// revertable" rule below. AWS::Scheduler::Schedule is the case: its CC read handler
// only looks in the DEFAULT schedule group (the override reads via Scheduler
// GetSchedule with the declared GroupName), but CC can update it fine. Verified live —
// a schedule State revert via CC succeeds for the common default-group case. (A
// non-default-group schedule would fail at apply with a clear AWS error, not silently.)
const CC_REVERTABLE_DESPITE_READ_OVERRIDE = new Set<string>(['AWS::Scheduler::Schedule']);

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

// An out-of-band ManagedPolicy attachment member (a live-only `Roles[x]`/`Users[x]`/
// `Groups[x]` — the union, surfaced as nested undeclared). Unlike a generic nested
// undeclared value, this one HAS a precise, flat SDK op to undo it (DetachX-Policy by
// member), so writeIamManagedPolicy can revert it exactly — it is NOT subject to the
// "nested undeclared is record-only" bar (which exists because a flat patch can't
// safely target a deep sub-field). Removal still requires --remove-unrecorded like any
// unrecorded undeclared value (the unrecorded guard below), so it never auto-detaches.
export function isManagedPolicyAttachmentMember(f: Finding): boolean {
  return (
    f.tier === 'undeclared' &&
    f.resourceType === 'AWS::IAM::ManagedPolicy' &&
    /^(Roles|Users|Groups)\[.+\]$/.test(f.path)
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

// True when a finding path is AT or UNDER any create-only schema path. The schema's
// `createOnlyPaths` are full dotted paths with `*` wildcards (e.g. `EncryptionConfiguration
// .KmsKey`, `PosixUser.*`, `Foo.*.Bar`); a finding's array-index segments (`[id]` or a
// numeric `.0`) align with those `*`. Segment-wise PREFIX membership, so a NESTED
// create-only property (parent mutable) is caught — the previous top-level-only check
// (`createOnly.has(firstSegment)`) missed those, and a `revert` then built an in-place
// patch that AWS rejects only at apply time (e.g. ECR `EncryptionConfiguration.KmsKey`,
// EFS AccessPoint `PosixUser.*`).
function pathSegments(path: string): string[] {
  return path
    .replace(/\[[^\]]*\]/g, '.*')
    .split('.')
    .filter((s) => s.length > 0);
}
function isUnderCreateOnly(findingPath: string, createOnlyPaths: readonly string[]): boolean {
  const f = pathSegments(findingPath);
  for (const co of createOnlyPaths) {
    const c = co.split('.');
    // Block when EITHER path is a prefix of the other (segment-wise; a `*` on either
    // side is a wildcard):
    //  - create-only path ⊆ finding path: the finding IS, or is nested under, a
    //    create-only property — an in-place patch on it is rejected (the nested
    //    create-only fix);
    //  - finding path ⊆ create-only path: the finding is a PARENT of a create-only
    //    property. drift-calculator emits a finding at the PARENT path for a
    //    length-/shape-changed array or object, so reverting it rewrites the whole
    //    subtree — INCLUDING the create-only descendant — which AWS also rejects as a
    //    replacement. Without this the revert proceeded and failed only at apply time
    //    (e.g. a length change in an object array whose elements carry a create-only
    //    sub-field, like EFS AccessPoint PosixUser under a replaced parent).
    const common = Math.min(c.length, f.length);
    let match = true;
    for (let i = 0; i < common; i++) {
      if (c[i] !== '*' && f[i] !== '*' && c[i] !== f[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
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
      // PR4: an UNRECORDED added resource (no baseline entry — the user has not decided
      // on it) is excluded from the default plan, exactly like an unrecorded undeclared
      // value: a default revert would DELETE it (the destructive mirror of the
      // subtractive model). Refuse unless --remove-unrecorded; the fork is the same —
      // record it if the live resource should stay, --remove-unrecorded to delete it.
      if (f.unrecorded && !opts.removeUnrecorded) {
        notRevertable.push({
          displayId,
          resourceType: f.resourceType,
          path: f.path,
          reason:
            'unrecorded — record it if the live resource is right, or --remove-unrecorded to delete it',
        });
        continue;
      }
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
    if (isNestedUndeclared(f) && !isManagedPolicyAttachmentMember(f)) {
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
    // CC-gap types are revertable only when we have a type-specific SDK writer — UNLESS
    // the override is a mere READ workaround on a CC-mutable type (see the set above),
    // in which case a CC UpdateResource revert is valid and we fall through to it.
    if (
      SDK_OVERRIDES[f.resourceType] &&
      !SDK_WRITERS[f.resourceType] &&
      !CC_REVERTABLE_DESPITE_READ_OVERRIDE.has(f.resourceType)
    ) {
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
    const schema = opts.schemas?.get(f.resourceType);
    if (schema && isUnderCreateOnly(f.path, schema.createOnlyPaths)) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'create-only property — change requires resource replacement',
      });
      continue;
    }
    // R111: an IAM Role whose sibling AWS::IAM::Policy names could NOT be resolved
    // statically keeps the sibling-managed (DefaultPolicy) entries in its live
    // Policies array — classify could not separate them, and marked this finding
    // accordingly. The per-entry writer (writeIamRoleInlinePolicies) deletes every
    // prior entry the declared set drops, so reverting here would DELETE a managed
    // inline policy, removing real IAM grants. Refuse rather than wrong-write.
    if (f.siblingPolicyNames === 'unresolved') {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'inline policies are managed by a sibling AWS::IAM::Policy whose name could not be resolved — reverting could delete a managed policy',
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
// Navigate a dotted path (e.g. `LoginProfile.Password`) in a declared model; returns
// undefined if any segment is missing or non-object. Used to re-include a NESTED
// write-only value from the template's intent.
function valueAtDottedPath(model: Record<string, unknown>, path: string): unknown {
  let node: unknown = model;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export function writeOnlyReincludeOps(
  declared: Record<string, unknown> | undefined,
  schema: SchemaInfo | undefined,
  existingOps: PatchOp[]
): PatchOp[] {
  if (!declared || !schema || schema.writeOnlyPaths.length === 0) return [];
  const touched = new Set(existingOps.map((o) => o.path));
  const ops: PatchOp[] = [];
  // Iterate the FULL write-only paths, not just the top-level set: a NESTED write-only
  // property (AWS::IAM::User LoginProfile.Password, AWS::Amplify::App
  // BasicAuthConfig.Password) is never a top-level key, so the old top-level-only loop
  // re-included nothing — and a cc revert touching another property sent the parent
  // object (e.g. LoginProfile, which CC returns WITHOUT the write-only Password) to
  // UpdateResource, which RESET the credential. Re-include each resolved write-only value
  // present in the declared model from its template intent.
  for (const path of schema.writeOnlyPaths) {
    if (path.includes('*')) continue; // a wildcard (array-element) write-only — no single value to re-include
    // A property that is write-only AND create-only must NEVER enter an update patch:
    // Cloud Control hard-rejects any op on a create-only path ("createOnlyProperties
    // [...] cannot be updated"), failing the WHOLE revert at apply time — even though
    // the op only re-includes the property to satisfy the read-modify-write contract.
    // Omitting it is also safe: a create-only property is fixed at creation, so the
    // provider's update handler preserves it regardless of whether the patch carries it
    // (unlike a mutable write-only prop, it cannot silently vanish). Live-proven by an
    // AWS::ElastiCache::ReplicationGroup revert: CacheSubnetGroupName is both write-only
    // and create-only, so re-including it made every revert fail "createOnlyProperties
    // [/properties/CacheSubnetGroupName] cannot be updated".
    if (isUnderCreateOnly(path, schema.createOnlyPaths)) continue;
    const value = valueAtDottedPath(declared, path);
    if (value === undefined || value === UNRESOLVED || hasUnresolved(value)) continue;
    const pointer = toPointer(path);
    if (touched.has(pointer)) continue;
    ops.push({
      op: 'add',
      path: pointer,
      value,
      human: `${path} -> re-include write-only (Cloud Control read-modify-write contract)`,
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
  const liveTags = liveRaw?.['Tags'];
  // MAP-shaped Tags (key->value, e.g. AWS::SSM::Parameter): the managed tags are aws:*
  // KEYS. awsManagedTags only understood the {Key,Value}[] list shape, so a map-shaped
  // /Tags revert dropped the aws:* keys -> AWS rejects ("aws: prefixed tag key names are
  // not allowed for external use"). Mirror stripTagsWalk/isAllAwsTags and preserve them.
  if (liveTags !== null && typeof liveTags === 'object' && !Array.isArray(liveTags)) {
    const managedMap = Object.fromEntries(
      Object.entries(liveTags).filter(([k]) => k.startsWith('aws:'))
    );
    if (Object.keys(managedMap).length === 0) return ops;
    return ops.map((op) => {
      if (op.path !== TAGS_POINTER) return op;
      const userMap =
        op.op === 'add' &&
        op.value !== null &&
        typeof op.value === 'object' &&
        !Array.isArray(op.value)
          ? Object.fromEntries(
              Object.entries(op.value as Record<string, unknown>).filter(
                ([k]) => !k.startsWith('aws:')
              )
            )
          : {};
      return {
        op: 'add',
        path: TAGS_POINTER,
        value: { ...userMap, ...managedMap },
        ...(op.prior !== undefined && { prior: op.prior }),
        human: `${op.human} (preserving aws:* managed tags)`,
      };
    });
  }
  const managed = awsManagedTags(liveTags);
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

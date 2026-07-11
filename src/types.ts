// Shared types for cdk-real-drift.

export type Tier =
  | 'deleted'
  | 'added' // a whole LIVE resource not in the deployed template — a child resource created out of band under a declared parent (e.g. an API Gateway Method on `/`). The resource-granularity sibling of `undeclared`; always drift. Detected by CHILD_ENUMERATORS (read/child-enumerators.ts), revertable by Cloud Control DeleteResource. physicalId carries the CC identifier.
  | 'declared'
  | 'undeclared'
  | 'atDefault' // undeclared, but the live value EQUALS a known AWS default (schema `default` or KNOWN_DEFAULTS) — informational inventory, folded in the report (R86); never drift, never recorded by record. An out-of-band change AWAY from the default no longer matches, so it re-surfaces as a real `undeclared` finding.
  | 'generated' // undeclared, but the live value EQUALS the AWS/CDK auto-generated value for THIS resource (its minted physical name, or a default-named log group derived from the physical id) — informational inventory, folded like atDefault; never drift, never recorded by record (it carries no intent, only the identity AWS minted). Equality-gated against the physical-id-substituted template, so an out-of-band edit no longer matches and re-surfaces as `undeclared`.
  | 'ignored' // re-tagged from declared/undeclared by a .cdkrd/ignore.yaml ignore rule (informational)
  | 'readGap'
  | 'unresolved'
  | 'skipped';

export interface Finding {
  tier: Tier;
  logicalId: string;
  physicalId?: string | undefined; // for revert (CC UpdateResource Identifier)
  constructPath?: string | undefined; // CDK construct path (from aws:cdk:path); display only
  resourceType: string;
  path: string;
  desired?: unknown;
  actual?: unknown;
  note?: string;
  // A non-classifying, human-facing EXPLANATION for a finding whose live value has a
  // recognizable external origin — e.g. the CloudWatch Application Signals / Lambda
  // Insights auto-instrumentation footprint (see diff/hints.ts, annotateHints). Unlike a
  // fold, it does NOT change the tier: the finding is still reported as real drift, the
  // hint only tells the user WHERE it likely came from ("enabled at the account/region
  // level, not per-resource"), so an unexpected account-wide enablement is never hidden.
  // Rendered as a dim trailing line in the text report and carried through --json.
  hint?: string;
  // undeclared tier only (R62): the value has NO baseline entry and its resource
  // was never snapshot-complete — the user has not decided on it yet, so it is an
  // UNRECORDED inventory item, not drift. Set by applyBaseline; excluded from the
  // verdict/exit and from revert's default plan (record or --remove-unrecorded).
  unrecorded?: boolean;
  // declared tier only (R78): for a drift INSIDE an identity-keyed attribute bag
  // (ELB Load/TargetGroupAttributes) this is the Key of the changed attribute. The
  // path stays at the bag property (`LoadBalancerAttributes`) and desired/actual
  // are the scalar Value; revert routes to the bag's SDK writer, which sends ONLY
  // this Key=Value via ModifyLoadBalancerAttributes (a Cloud Control index patch
  // would misalign against the full live bag and exceed ELB's 20-attribute cap).
  attributeKey?: string;
  // undeclared tier only (R96/R98): the value is a live SUB-key inside a DECLARED
  // object that the template never set (a nested undeclared property, dotted path).
  // Detected by recursing the declared/live objects — and, since R98, into the
  // MATCHED elements of identity-keyed object arrays (path `Prop[<id>].sub`), so a
  // live-only sub-field inside a declared Tags/Origins/… element is caught too.
  // Reported folded by default (the live model carries many nested AWS defaults),
  // expanded by --show-all; recorded by record like any undeclared value, so a later
  // out-of-band change to it surfaces.
  nested?: boolean;
  // undeclared tier only: a nested undeclared value (so `nested` is also set) that lives
  // inside a FREE-FORM MAP property (SchemaInfo.freeFormMapPaths — Lambda
  // Environment.Variables, Glue Parameters, …). Every key in such a map is user-authored,
  // never an AWS-materialized default, so unlike a generic nested value it is NOT folded:
  // the report surfaces it in full (a console-added env var is real, reviewable drift, not
  // first-run noise). Revertability is independent (path-shape based, isUnrevertableNested).
  freeFormKey?: boolean;
  // undeclared tier only (R128): a recorded undeclared identity-keyed object array
  // (e.g. an IAM Role's inline Policies keyed by PolicyName) whose value CHANGED vs
  // the baseline — set by applyBaseline for the REPORT only. The finding still names
  // the whole-array path (so record keeps snapshotting the whole array and the
  // property never un-records); this just describes WHICH element(s) differ so the
  // report shows the delta, not the full array dump. See `identityArrayDelta`.
  arrayDelta?: ArrayDelta;
  // added tier only (PR4): the child's FULL live model could NOT be read this run (the
  // CC GetResource failed), so `actual` is only the enumerator's identity snippet. The
  // resource still EXISTS and is reported, but it is not change-watchable this run:
  // `record` skips snapshotting a partial model, and `applyBaseline` never cries
  // "changed since record" off the degraded snippet (it suppresses a recorded one until
  // a clean read, like a transiently-skipped resource). Self-heals on the next check.
  modelReadFailed?: boolean;
  // declared tier only (R111): set to 'unresolved' on an IAM Role `Policies` finding
  // when the role's sibling AWS::IAM::Policy names could NOT be resolved, so classify
  // left the sibling-managed (DefaultPolicy) entries in the live array. The revert plan
  // reads this and refuses to act — a per-entry revert would DELETE a managed inline
  // policy (real IAM grants). Mirrors DesiredResource.siblingPolicyNames; only the
  // 'unresolved' sentinel is propagated (the resolved case is already filtered out).
  siblingPolicyNames?: 'unresolved' | undefined;
  // declared tier only: this per-element finding lives inside an UNORDERED_OBJECT_ARRAY
  // (a SET the service returns REORDERED — SecurityGroup rules, PrefixList Entries, …).
  // classify sorts BOTH sides by canonical JSON before the positional subset diff, so the
  // finding's array-index segment is the SORTED position, which does NOT map to the live
  // array's raw index. A Cloud Control index patch (`add /Entries/2/Description`) would then
  // hit the WRONG live element and corrupt it (proven live on a reordered PrefixList). So
  // revert must NOT sub-path patch such a finding: it carries the WHOLE declared array here
  // and the revert plan collapses every per-element finding of the same array into ONE
  // whole-array `add /<path>` replacement (converges deterministically regardless of live
  // order). The per-element REPORT is unaffected — this is revert-only metadata.
  wholeArrayRevert?: { path: string; value: unknown } | undefined;
  // ignored tier only (#1277): the ORIGINAL tier this finding carried BEFORE applyIgnores
  // re-tagged it to `ignored`. The `ignored` tier discards the source tier, but the #1078
  // completeness demotion in computeCompleteResources must ONLY fire for an ignored value
  // that originated as `undeclared` (record snapshots undeclared/added only, so a
  // never-recorded undeclared value legitimately keeps its resource incomplete). An ignored
  // DECLARED (or `added`) path is NEVER in `recorded`, so demoting on it would fire
  // UNCONDITIONALLY and silently mark the resource not-snapshot-complete — a later
  // out-of-band appearance would then read `unrecorded` instead of confirmed "appeared since
  // record" drift (an FN downgrade). The provenance gates the demotion to the undeclared case.
  ignoredFrom?: Tier | undefined;
}

// Element-level delta of a recorded-but-changed undeclared identity-keyed object
// array (R128). DISPLAY metadata only: the finding stays at the whole-array path.
export interface ArrayDelta {
  identityField: string; // the field the elements were aligned by (e.g. 'PolicyName')
  added: { id: string; value: unknown }[]; // live elements with no baseline match
  removed: { id: string; value: unknown }[]; // baseline elements gone from live
  changed: { id: string; recorded: unknown; actual: unknown }[]; // matched id, content differs
}

export interface SchemaInfo {
  readOnly: Set<string>; // top-level read-only names (fast checks)
  writeOnly: Set<string>; // top-level write-only names (fast checks)
  createOnly: Set<string>; // top-level create-only names (changing them needs replacement)
  readOnlyPaths: string[]; // full dotted paths incl '*' wildcard (strip from live, any depth)
  writeOnlyPaths: string[]; // full dotted paths incl '*' wildcard (skip from compare, any depth)
  createOnlyPaths: string[]; // full dotted paths incl '*' wildcard (revert is impossible — replacement)
  // Full dotted paths (incl '*' wildcard) of the schema's `conditionalCreateOnlyProperties`
  // — props that are create-only ONLY in a specific case (an RDS read replica, a
  // snapshot-restored DBInstance) and MUTABLE in the common case. These are deliberately
  // NOT merged into `createOnlyPaths` (that would bar revert of everyday mutable props like
  // RDS BackupRetentionPeriod — #413/#421), so the revert BAR ignores them. But
  // `writeOnlyReincludeOps` MUST still SKIP them: re-including a conditional-create-only
  // write-only prop into a CC read-modify-write patch makes the provider's update handler
  // see it as newly ADDED (a read handler never returns a write-only prop), and for a prop
  // that is create-only in its condition the "added" transition is the create-only case →
  // the whole revert fails (#1330, the #252 failure class). Omitting it is safe: it is fixed
  // at creation in that condition and the provider preserves an absent write-only prop it
  // cannot diff. Optional: production (parseSchema / reviveSchema / EMPTY) sets it; older
  // corpus fixtures may omit it (read with `?.`).
  conditionalCreateOnlyPaths?: string[];
  defaults: Record<string, unknown>; // top-level schema `default` values
  defaultPaths: Record<string, unknown>; // schema `default` values at ANY depth, dotted-path keyed ('*' for array items)
  // Dotted paths of arrays the schema marks `insertionOrder: false` (AWS declares the
  // array UNORDERED) whose items are SCALAR — a reorder of these is never drift, so
  // classify folds a same-multiset difference at one of these paths. Schema-driven so
  // it needs no per-type table and is FN-safe (AWS itself says order is meaningless).
  // Optional: production (parseSchema / reviveSchema / EMPTY) always sets it; test
  // fixtures and pre-insertionOrder corpus cases may omit it (classify reads it with `?.`).
  unorderedScalarPaths?: string[];
  // Dotted paths of arrays the schema marks `insertionOrder: false` whose items are
  // OBJECTS with NO identity field (Key/Id/AttributeName/IndexName/Name — those are
  // already aligned by canonicalizeTagListsDeep, and re-sorting them would churn the
  // established canonical order). The schema explicitly asserts the array is UNORDERED,
  // so classify sorts BOTH sides by canonical JSON before the positional diff — the same
  // mechanics as the per-type UNORDERED_OBJECT_ARRAY_PROPS opt-in, but schema-driven and
  // type-agnostic (closes the ArchiveRules-shaped FP class, #459). FN-safe by the same
  // argument as unorderedScalarPaths; a genuine element change still differs after the
  // sort. Optional like the above; classify reads it with `?.`.
  unorderedObjectArrayPaths?: string[];
  // Dotted paths of FREE-FORM MAP properties — `type: object` schema nodes with no fixed
  // `properties`, just `patternProperties`/object `additionalProperties` (Lambda
  // Environment.Variables, Glue Parameters, DockerLabels). Every KEY in such a map is
  // user-authored, NOT an AWS-materialized nested default, so a live-only sub-key under one
  // is surfaced in the report rather than folded into the `undeclared-subkey` count (R96).
  // Optional like the above; classify reads it with `?.`.
  freeFormMapPaths?: string[];
  // Dotted paths (with '*' array-item wildcard) → the schema's `propertyTransform` JSONata
  // expression for that property. CloudFormation's OWN drift detection uses `propertyTransform`
  // to suppress false drift: the SERVICE transforms a declared value before storing it (Lambda
  // EventSourceMapping StartingPositionTimestamp ×1000 s→ms, Cassandra ColumnType $lowercase,
  // AmazonMQ DayOfWeek $uppercase, EKS Addon ConfigurationValues trailing-newline strip), so the
  // live read differs from the template value even though nothing drifted. classify evaluates
  // transform(declared) and, when it deep-equals live, folds the finding (equality-gated + FAIL-
  // OPEN — it can ONLY suppress a declared FP where the transform reproduces live exactly, never
  // hide real drift). The value may carry ` $OR `-separated alternatives (classify tries each).
  // Optional like the paths above; classify reads it with `?.`. (#881)
  propertyTransforms?: Record<string, string>;
  // True when the CFn resource schema's `handlers` block declares an `update` handler;
  // false when handlers ARE present but `update` is absent — the type is create/read/delete
  // only (e.g. AWS::CloudFront::MonitoringSubscription), so a Cloud Control UpdateResource
  // always fails at apply with a raw UnsupportedActionException, and revert must bar the
  // cc-kind item instead of emitting a patch that can never succeed (#908). UNDEFINED when
  // the schema had NO handlers block at all (unknown updatability — e.g. a DescribeType
  // failure returning EMPTY): revert must NOT bar on unknown, to avoid regressing on
  // schema-unavailable degradation (#858 handles that separately). Optional like the above.
  updatable?: boolean | undefined;
  // True when the CFn resource schema carries a `handlers` block AT ALL (regardless of which
  // handlers it declares); false when the schema is present but has NO `handlers` block — a
  // CFn-legacy type (e.g. AWS::CertificateManager::Certificate) whose auto-generated registry
  // schema predates the handler model, so Cloud Control UpdateResource always fails at apply
  // with a raw UnsupportedActionException. UNDEFINED when the schema itself is unavailable
  // (DescribeType failure → EMPTY): unlike `hasHandlers === false`, that degradation must NOT
  // bar a revert (#858). Lets the #908/#1091 revert bar tell "handlers legitimately absent"
  // apart from "schema unavailable" instead of overloading `updatable === undefined` for both.
  // Optional like the above (set by parseSchema; test/corpus fixtures may omit it). (#1091)
  hasHandlers?: boolean | undefined;
}

export interface ResolverContext {
  params: Record<string, string | string[]>; // CommaDelimitedList / List<> params resolve to arrays

  pseudo: Record<string, string>;
  conditions: Record<string, unknown>;
  physIds: Record<string, string>; // logicalId -> physicalId
  // logicalId -> the referenced resource's live model (CC/SDK read), used to
  // resolve Fn::GetAtt against real attributes instead of guessing ARN formats.
  // Empty on the first (pre-live-read) resolve pass; populated for the re-resolve.
  liveAttrs: Record<string, Record<string, unknown>>;
  // logicalId -> resource type, and logicalId -> RAW declared Properties. Used by
  // resolveGetAtt to resolve an Fn::GetAtt whose attribute MIRRORS a declared property
  // (GETATT_DECLARED_PROPERTY, e.g. an IdentityPool's readOnly `Name` == its declared
  // `IdentityPoolName`) against the template-declared value instead of the live value —
  // so an out-of-band change to that resource does not cascade into phantom drift on
  // every consumer that interpolates the attribute into one of its own declared
  // properties. Optional: pre-resolver-context call sites (tests) may omit them.
  typeOf?: Record<string, string>;
  declaredRawProps?: Record<string, Record<string, unknown>>;
  // template.Mappings (MapName -> TopKey -> SecondKey -> value), for Fn::FindInMap
  mappings: Record<string, Record<string, Record<string, unknown>>>;
  exports: Record<string, string>; // CFn export Name -> Value, for Fn::ImportValue (prefetched)
  // SSM parameter name -> value, for the CDK `crossRegionReferences: true` pattern. A
  // `Custom::CrossRegionExportReader` materializes each imported value as an SSM parameter
  // named `/cdk/exports/<exportName>` in the CONSUMER region, and the consumer property
  // becomes `{ Fn::GetAtt: [<Reader>, "/cdk/exports/<name>"] }`. Prefetched (one
  // ssm:GetParameters batch) so resolveGetAtt can resolve that GetAtt instead of leaving it
  // UNRESOLVED (which would make an out-of-band cert swap invisible). Optional: absent unless
  // the template actually references such a reader; a name missing here fails closed to
  // UNRESOLVED. Keyed by the FULL SSM parameter name (the GetAtt attribute).
  crossRegionExports?: Record<string, string>;
  condCache: Map<string, unknown>; // true | false | UNRESOLVED (fail-closed)
}

export interface DesiredResource {
  logicalId: string;
  resourceType: string;
  physicalId?: string | undefined;
  constructPath?: string | undefined; // CDK construct path from aws:cdk:path Metadata (display only)
  declared: Record<string, unknown>; // intrinsic-resolved + NoValue-pruned (may carry UNRESOLVED)
  declaredRaw?: Record<string, unknown>; // raw Properties, re-resolved by gather once liveAttrs are read
  // inline Policies on an IAM principal (Role / User / Group) owned by sibling
  // AWS::IAM::Policy resources (the CDK pattern). classify drops ONLY the live entries
  // whose PolicyName is listed here, so an out-of-band inline policy is still reported.
  // 'unresolved' = a sibling PolicyName is not statically resolvable -> fall back to
  // suppressing the whole live Policies property (no false positives).
  siblingPolicyNames?: string[] | 'unresolved' | undefined;
  // true when an ECS Cluster's CapacityProviders / DefaultCapacityProviderStrategy are
  // declared by a sibling AWS::ECS::ClusterCapacityProviderAssociations resource (which
  // reflects them into the cluster's live model). classify drops the reflected props so
  // they are not false undeclared drift — the association is tracked as its own resource.
  hasSiblingCapacityProviders?: boolean | undefined;
}

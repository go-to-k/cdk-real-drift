// Shared types for cdk-real-drift.

export type Tier =
  | 'deleted'
  | 'declared'
  | 'undeclared'
  | 'atDefault' // undeclared, but the live value EQUALS a known AWS default (schema `default` or KNOWN_DEFAULTS) — informational inventory, folded in the report (R86); never drift, never recorded by accept. An out-of-band change AWAY from the default no longer matches, so it re-surfaces as a real `undeclared` finding.
  | 'ignored' // re-tagged from declared/undeclared by a .cdkrd/config.json ignore rule (informational)
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
  // undeclared tier only (R62): the value has NO baseline entry and its resource
  // was never snapshot-complete — the user has not decided on it yet, so it is an
  // UNRECORDED inventory item, not drift. Set by applyBaseline; excluded from the
  // verdict/exit and from revert's default plan (accept or --remove-unaccepted).
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
  // expanded by --show-all; recorded by accept like any undeclared value, so a later
  // out-of-band change to it surfaces.
  nested?: boolean;
}

export interface SchemaInfo {
  readOnly: Set<string>; // top-level read-only names (fast checks)
  writeOnly: Set<string>; // top-level write-only names (fast checks)
  createOnly: Set<string>; // top-level create-only names (changing them needs replacement)
  readOnlyPaths: string[]; // full dotted paths incl '*' wildcard (strip from live, any depth)
  writeOnlyPaths: string[]; // full dotted paths incl '*' wildcard (skip from compare, any depth)
  createOnlyPaths: string[]; // full dotted paths incl '*' wildcard (revert is impossible — replacement)
  defaults: Record<string, unknown>; // top-level schema `default` values
  defaultPaths: Record<string, unknown>; // schema `default` values at ANY depth, dotted-path keyed ('*' for array items)
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
  // template.Mappings (MapName -> TopKey -> SecondKey -> value), for Fn::FindInMap
  mappings: Record<string, Record<string, Record<string, unknown>>>;
  exports: Record<string, string>; // CFn export Name -> Value, for Fn::ImportValue (prefetched)
  condCache: Map<string, unknown>; // true | false | UNRESOLVED (fail-closed)
}

export interface DesiredResource {
  logicalId: string;
  resourceType: string;
  physicalId?: string | undefined;
  constructPath?: string | undefined; // CDK construct path from aws:cdk:path Metadata (display only)
  declared: Record<string, unknown>; // intrinsic-resolved + NoValue-pruned (may carry UNRESOLVED)
  declaredRaw?: Record<string, unknown>; // raw Properties, re-resolved by gather once liveAttrs are read
  // inline Policies on an IAM Role owned by sibling AWS::IAM::Policy resources (the
  // CDK pattern). classify drops ONLY the live entries whose PolicyName is listed
  // here, so an out-of-band inline policy is still reported. 'unresolved' = a
  // sibling PolicyName is not statically resolvable -> fall back to suppressing the
  // whole live Policies property (no false positives).
  siblingPolicyNames?: string[] | 'unresolved' | undefined;
}

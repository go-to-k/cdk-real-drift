// Shared types for cdk-real-drift.

export type Tier =
  | 'deleted'
  | 'declared'
  | 'undeclared'
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
}

export interface SchemaInfo {
  readOnly: Set<string>; // top-level read-only names (fast checks)
  writeOnly: Set<string>; // top-level write-only names (fast checks)
  createOnly: Set<string>; // top-level create-only names (changing them needs replacement)
  readOnlyPaths: string[]; // full dotted paths incl '*' wildcard (strip from live, any depth)
  writeOnlyPaths: string[]; // full dotted paths incl '*' wildcard (skip from compare, any depth)
  createOnlyPaths: string[]; // full dotted paths incl '*' wildcard (revert is impossible — replacement)
  defaults: Record<string, unknown>; // top-level schema `default` values
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

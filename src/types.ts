// Shared types for cdk-real-drift.

export type Tier = 'declared' | 'undeclared' | 'readGap' | 'unresolved' | 'skipped';

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
  readOnlyPaths: string[]; // full dotted paths incl '*' wildcard (strip from live, any depth)
  writeOnlyPaths: string[]; // full dotted paths incl '*' wildcard (skip from compare, any depth)
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
  condCache: Map<string, unknown>; // true | false | UNRESOLVED (fail-closed)
}

export interface DesiredResource {
  logicalId: string;
  resourceType: string;
  physicalId?: string | undefined;
  constructPath?: string | undefined; // CDK construct path from aws:cdk:path Metadata (display only)
  declared: Record<string, unknown>; // intrinsic-resolved + NoValue-pruned (may carry UNRESOLVED)
  declaredRaw?: Record<string, unknown>; // raw Properties, re-resolved by gather once liveAttrs are read
  siblingManaged?: boolean; // an IAM Role whose inline Policies are managed by a sibling AWS::IAM::Policy
}

// Shared types for cdk-real-drift.

export type Tier = 'declared' | 'undeclared' | 'readGap' | 'unresolved' | 'skipped';

export interface Finding {
  tier: Tier;
  logicalId: string;
  resourceType: string;
  path: string;
  desired?: unknown;
  actual?: unknown;
  note?: string;
}

export interface SchemaInfo {
  readOnly: Set<string>; // top-level property names that are read-only (strip as noise)
  writeOnly: Set<string>; // top-level property names not readable back (skip)
  defaults: Record<string, unknown>; // top-level schema `default` values
}

export interface ResolverContext {
  params: Record<string, string>;
  pseudo: Record<string, string>;
  conditions: Record<string, unknown>;
  physIds: Record<string, string>; // logicalId -> physicalId
  condCache: Map<string, boolean>;
}

export interface DesiredResource {
  logicalId: string;
  resourceType: string;
  physicalId?: string;
  declared: Record<string, unknown>; // intrinsic-resolved + NoValue-pruned (may carry UNRESOLVED)
}

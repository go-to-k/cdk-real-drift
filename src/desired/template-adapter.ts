// NEW. Builds the "declared desired" view of a deployed stack:
//   GetTemplate            → the deployed CloudFormation template
//   DescribeStackResources → logicalId → physicalId map (+ resourceType)
//   intrinsic resolution   → resolve Ref/GetAtt/Sub/If against live phys-ids
//
// This is the key retarget vs cdkd: cdkd resolves from its OWN state; here the
// desired comes live from the deployed template + the live stack's phys-id map.
//
// COPY from cdkd: deployment/intrinsic-function-resolver.ts (feed phys-ids into
//   ResolverContext.resources; conditions from the template's Conditions block).

export interface DesiredResource {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  declared: Record<string, unknown>; // resolved declared properties (intrinsics evaluated)
}

export interface Desired {
  stackName: string;
  region: string;
  resources: DesiredResource[];
}

export async function loadDesired(_stack: string, _region: string): Promise<Desired> {
  // TODO(phase2): GetTemplate + DescribeStackResources + resolve.
  //   IMPORTANT: scope declared-prop extraction to each logical id
  //   (Phase 1 lesson: an unscoped grab cross-contaminates and yields false drift).
  throw new Error('not implemented');
}

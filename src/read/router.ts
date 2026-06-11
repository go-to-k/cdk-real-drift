// Read source router (per resource TYPE):
//   SDK override (for common types Cloud Control API can't read) → CC API
//   GetResource → skip + log. Declared/undeclared labeling happens later.
import { type CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { isResourceNotFoundError } from '../aws-errors.js';
import type { DesiredResource } from '../types.js';
import { SDK_OVERRIDES } from './overrides.js';

export interface ReadResult {
  live?: Record<string, unknown>; // un-stripped property model
  skippedReason?: string;
  deleted?: boolean; // the resource was deleted out of band (read returned not-found)
}

export async function readLive(
  cc: CloudControlClient,
  resource: DesiredResource,
  region: string,
  accountId: string
): Promise<ReadResult> {
  const { resourceType, physicalId, declared } = resource;
  // Custom resources are backed by a user Lambda; there is NO Cloud Control type to
  // read, so calling GetResource just wastes an API round-trip (+ retries) and
  // returns a misleading "ValidationException". Short-circuit to a clear skip.
  if (resourceType.startsWith('Custom::') || resourceType === 'AWS::CloudFormation::CustomResource')
    return { skippedReason: 'custom resource — no cloud-side model to read' };
  const override = SDK_OVERRIDES[resourceType];
  if (override) {
    try {
      const live = await override({ physicalId: physicalId ?? '', declared, region, accountId });
      return live
        ? { live }
        : { skippedReason: 'SDK override: target not resolvable from template' };
    } catch (e) {
      if (isResourceNotFoundError(e)) return { deleted: true };
      return { skippedReason: `SDK override (${resourceType}): ${(e as Error).name}` };
    }
  }
  try {
    const g = await cc.send(
      new GetResourceCommand({ TypeName: resourceType, Identifier: physicalId ?? '' })
    );
    return { live: JSON.parse(g.ResourceDescription?.Properties ?? '{}') };
  } catch (e) {
    if (isResourceNotFoundError(e)) return { deleted: true };
    return { skippedReason: `CC API: ${(e as Error).name}` };
  }
}

// Read source router (per resource TYPE):
//   SDK override (for common types Cloud Control API can't read) → CC API
//   GetResource → skip + log. Declared/undeclared labeling happens later.
import { GetResourceCommand, type CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import type { DesiredResource } from '../types.js';
import { SDK_OVERRIDES } from './overrides.js';

export interface ReadResult {
  live?: Record<string, unknown>; // un-stripped property model
  skippedReason?: string;
}

export async function readLive(
  cc: CloudControlClient,
  resource: DesiredResource,
  region: string,
  accountId: string,
): Promise<ReadResult> {
  const { resourceType, physicalId, declared } = resource;
  const override = SDK_OVERRIDES[resourceType];
  if (override) {
    try {
      const live = await override({ physicalId: physicalId ?? '', declared, region, accountId });
      return live ? { live } : { skippedReason: 'SDK override: target not resolvable from template' };
    } catch (e) {
      return { skippedReason: `SDK override (${resourceType}): ${(e as Error).name}` };
    }
  }
  try {
    const g = await cc.send(new GetResourceCommand({ TypeName: resourceType, Identifier: physicalId ?? '' }));
    return { live: JSON.parse(g.ResourceDescription?.Properties ?? '{}') };
  } catch (e) {
    return { skippedReason: `CC API: ${(e as Error).name}` };
  }
}

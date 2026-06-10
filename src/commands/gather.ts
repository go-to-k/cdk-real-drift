// Shared read+classify pipeline used by both `check` and `accept`.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import type { Finding } from '../types.js';
import { loadDesired, type Desired } from '../desired/template-adapter.js';
import { readLive } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import { classifyResource } from '../diff/classify.js';

export interface GatherResult {
  desired: Desired;
  findings: Finding[];
}

export async function gatherFindings(stackName: string, region: string): Promise<GatherResult> {
  const cfn = new CloudFormationClient({ region });
  const cc = new CloudControlClient({ region });

  const desired = await loadDesired(cfn, stackName, region);
  const findings: Finding[] = [];

  for (const r of desired.resources) {
    if (!r.physicalId) {
      findings.push({ tier: 'skipped', logicalId: r.logicalId, resourceType: r.resourceType, path: '', note: 'no physical id' });
      continue;
    }
    const read = await readLive(cc, r, region, desired.accountId);
    if (read.skippedReason || !read.live) {
      findings.push({ tier: 'skipped', logicalId: r.logicalId, resourceType: r.resourceType, path: '', note: read.skippedReason });
      continue;
    }
    const schema = await getSchemaInfo(cfn, r.resourceType);
    findings.push(...classifyResource(r, read.live, schema));
  }
  return { desired, findings };
}

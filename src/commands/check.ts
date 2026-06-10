// `cdkdrift check <stack> [--region r]` — read-only drift check.
//   loadDesired → per resource: readLive (CC) + getSchemaInfo → classify → report.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import type { Finding } from '../types.js';
import { loadDesired } from '../desired/template-adapter.js';
import { readLive } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import { classifyResource } from '../diff/classify.js';
import { report } from '../report/report.js';

export async function runCheck(args: string[]): Promise<number> {
  const stackName = args.find((a) => !a.startsWith('-'));
  const regionIdx = args.indexOf('--region');
  const region = regionIdx >= 0 ? args[regionIdx + 1] : process.env.AWS_REGION ?? 'us-east-1';
  if (!stackName) {
    console.error('usage: cdkdrift check <stack> [--region r]');
    return 2;
  }
  const cfn = new CloudFormationClient({ region });
  const cc = new CloudControlClient({ region });

  const desired = await loadDesired(cfn, stackName, region);
  const findings: Finding[] = [];

  for (const r of desired.resources) {
    if (!r.physicalId) {
      findings.push({ tier: 'skipped', logicalId: r.logicalId, resourceType: r.resourceType, path: '', note: 'no physical id' });
      continue;
    }
    const read = await readLive(cc, r.resourceType, r.physicalId);
    if (read.skippedReason || !read.live) {
      findings.push({ tier: 'skipped', logicalId: r.logicalId, resourceType: r.resourceType, path: '', note: read.skippedReason });
      continue;
    }
    const schema = await getSchemaInfo(cfn, r.resourceType);
    findings.push(...classifyResource(r, read.live, schema));
  }

  return report(findings, `${stackName} (${region})`);
}

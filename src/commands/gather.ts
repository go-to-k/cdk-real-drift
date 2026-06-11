// Shared read+classify pipeline used by both `check` and `accept`.

import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { classifyResource } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { readLive } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import type { Finding } from '../types.js';

export interface GatherResult {
  desired: Desired;
  findings: Finding[];
}

export async function gatherFindings(
  stackName: string,
  region: string,
  // --pre-deploy: use the LOCAL synth template as the declared source instead of
  // the deployed template, so check reports the declared drift the next deploy
  // would overwrite. physIds + live reads still come from the deployed stack.
  templateOverride?: Record<string, unknown>
): Promise<GatherResult> {
  const cfn = new CloudFormationClient({ region });
  const cc = new CloudControlClient({ region });

  const desired = await loadDesired(cfn, stackName, region, templateOverride);
  const findings: Finding[] = [];

  // Pass 1: read every resource's live model first, so Fn::GetAtt in any
  // resource's declared props can be resolved against the referenced resource's
  // real attributes (populates ctx.liveAttrs) instead of falling to UNRESOLVED.
  const reads = new Map<string, Awaited<ReturnType<typeof readLive>>>();
  for (const r of desired.resources) {
    if (!r.physicalId) continue;
    const read = await readLive(cc, r, region, desired.accountId);
    reads.set(r.logicalId, read);
    if (read.live) desired.ctx.liveAttrs[r.logicalId] = read.live;
  }

  // Pass 2: re-resolve declared with liveAttrs populated, then classify.
  for (const r of desired.resources) {
    if (!r.physicalId) {
      findings.push({
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: 'no physical id',
      });
      continue;
    }
    const read = reads.get(r.logicalId);
    if (!read || read.skippedReason || !read.live) {
      findings.push({
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: read?.skippedReason ?? 'not readable',
      });
      continue;
    }
    // re-resolve GetAtt now that all live attributes are known; mutate declared
    // in place so downstream consumers (revert / accept) see the resolved view.
    if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
    const schema = await getSchemaInfo(cfn, r.resourceType);
    findings.push(...classifyResource(r, read.live, schema));
  }
  return { desired, findings };
}

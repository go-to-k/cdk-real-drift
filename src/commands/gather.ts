// Shared read+classify pipeline used by both `check` and `accept`.

import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { classifyResource } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { fetchManagedAliasTargets, usesManagedKmsAlias } from '../read/kms-aliases.js';
import { readLive } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import type { Finding, SchemaInfo } from '../types.js';

export interface GatherResult {
  desired: Desired;
  findings: Finding[];
  schemas: Map<string, SchemaInfo>; // resourceType -> schema (so revert can honor createOnly)
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
  const schemas = new Map<string, SchemaInfo>();

  // Pass 1: read every resource's live model first, so Fn::GetAtt in any
  // resource's declared props can be resolved against the referenced resource's
  // real attributes (populates ctx.liveAttrs) instead of falling to UNRESOLVED.
  // Bounded-concurrency worker pool (pull-next-when-free): serial reads cost
  // ~300ms each, so 200+ resources took >1min; the SDK's adaptive retry handles
  // any throttling. Pass-2 ordering stays deterministic (iterates desired.resources).
  const reads = new Map<string, Awaited<ReturnType<typeof readLive>>>();
  const targets = desired.resources.filter((r) => r.physicalId);
  const POOL_SIZE = 6;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const r = targets[cursor++]!;
      const read = await readLive(cc, r, region, desired.accountId);
      reads.set(r.logicalId, read);
      if (read.live) desired.ctx.liveAttrs[r.logicalId] = read.live;
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, targets.length) }, () => worker()));

  // KMS managed-alias resolution (R9): only if the stack declares any `alias/aws/*`,
  // fetch alias -> target key id once so classify can tell a managed-default key from
  // a customer-managed key swapped in out of band. Missing kms:ListAliases -> {} (the
  // classifier falls back to the conservative shape-based match).
  const kmsAliasTargets = desired.resources.some((r) => usesManagedKmsAlias(r.declared))
    ? await fetchManagedAliasTargets(region)
    : {};
  const classifyOpts = { accountId: desired.accountId, region, kmsAliasTargets };

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
    if (read?.deleted) {
      findings.push({
        tier: 'deleted',
        logicalId: r.logicalId,
        physicalId: r.physicalId,
        constructPath: r.constructPath,
        resourceType: r.resourceType,
        path: '',
        note: 'resource deleted out of band',
      });
      continue;
    }
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
    schemas.set(r.resourceType, schema);
    findings.push(...classifyResource(r, read.live, schema, classifyOpts));
  }
  return { desired, findings, schemas };
}

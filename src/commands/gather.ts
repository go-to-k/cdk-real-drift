// Shared read+classify pipeline used by both `check` and `accept`.

import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { classifyResource } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { READ_RETRY } from '../read/client-config.js';
import { fetchManagedAliasTargets, usesManagedKmsAlias } from '../read/kms-aliases.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
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
  const cfn = new CloudFormationClient({ region, ...READ_RETRY });
  const cc = new CloudControlClient({ region, ...READ_RETRY });

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

  // Re-resolve EVERY resource's declared now that pass 1 populated all live
  // attributes, so Fn::GetAtt resolves. Hoisted out of pass 2 because pass 1.5
  // (below) needs the resolved declared. Mutated in place so downstream consumers
  // (revert / accept) see the resolved view.
  for (const r of desired.resources) {
    if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
  }

  // Pass 1.5: declared-dependent SDK overrides key off props that are frequently
  // Fn::GetAtt (AWS::Lambda::Permission.FunctionName = GetAtt[fn, Arn]). Those were
  // UNRESOLVED during pass 1 (liveAttrs was still being filled), so their pass-1
  // override read wrongly skipped as "target not resolvable" — the resource is
  // structurally readable, we just asked too early. Re-read ONCE, concurrently, the
  // override-routed resources that pass 1 skipped and whose target is now resolvable.
  const retryTargets = desired.resources.filter(
    (r) =>
      r.physicalId &&
      r.declaredRaw &&
      SDK_OVERRIDES[r.resourceType] &&
      reads.get(r.logicalId)?.skippedReason
  );
  let rc = 0;
  const retryWorker = async (): Promise<void> => {
    while (rc < retryTargets.length) {
      const r = retryTargets[rc++]!;
      const read = await readLive(cc, r, region, desired.accountId);
      reads.set(r.logicalId, read);
      if (read.live) desired.ctx.liveAttrs[r.logicalId] = read.live;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(POOL_SIZE, retryTargets.length) }, () => retryWorker())
  );

  // KMS managed-alias resolution (R9): only if the stack declares any `alias/aws/*`,
  // fetch alias -> target key id once so classify can tell a managed-default key from
  // a customer-managed key swapped in out of band. Missing kms:ListAliases -> {} (the
  // classifier falls back to the conservative shape-based match).
  const kmsAliasTargets = desired.resources.some((r) => usesManagedKmsAlias(r.declared))
    ? await fetchManagedAliasTargets(region)
    : {};
  const classifyOpts = { accountId: desired.accountId, region, kmsAliasTargets };

  // Pass 2: classify (declared already re-resolved + override retries applied above).
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
    const schema = await getSchemaInfo(cfn, r.resourceType);
    schemas.set(r.resourceType, schema);
    findings.push(...classifyResource(r, read.live, schema, classifyOpts));
  }
  return { desired, findings, schemas };
}

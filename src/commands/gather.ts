// Shared read+classify pipeline used by both `check` and `record`.

import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { buildCorpusCase, CORPUS_DIR_ENV, recordCorpusCase } from '../corpus/record.js';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { classifyResource } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { READ_RETRY } from '../read/client-config.js';
import {
  fetchManagedAliasTargets,
  kmsListAliasesDeniedWarning,
  usesManagedKmsAlias,
} from '../read/kms-aliases.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import { readLive, type ReadResult } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import type { DesiredResource, Finding, SchemaInfo } from '../types.js';

export interface GatherResult {
  desired: Desired;
  findings: Finding[];
  schemas: Map<string, SchemaInfo>; // resourceType -> schema (so revert can honor createOnly)
  // logicalId -> the UN-stripped live model (CC GetResource / SDK override read), kept so
  // the revert write path can see live-only data the compare-side strips — notably the
  // `aws:*` managed tags `stripAwsTagsDeep` removes, which a Tags revert must preserve on
  // the WRITE side (tagPreservingOps). Resources with no readable live model are absent.
  liveByLogical: Map<string, Record<string, unknown>>;
}

// Project the per-resource live reads into the logicalId -> live-model map carried on
// GatherResult (only the resources that actually read back a model).
function liveModelMap(reads: Map<string, ReadResult>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const [logicalId, read] of reads) if (read.live) out.set(logicalId, read.live);
  return out;
}

// Regions already warned about a denied kms:ListAliases — the warning is one-per-region
// (a multi-stack run in the same region should not repeat it). Process-lifetime (matches
// the per-region alias cache in kms-aliases.ts).
const kmsDeniedWarned = new Set<string>();

// Bounded-concurrency live-read pool (pull-next-when-free): serial reads cost
// ~300ms each, so 200+ resources took >1min; the SDK's adaptive retry handles
// any throttling. Stores each read in `reads` and feeds ctx.liveAttrs so
// Fn::GetAtt can resolve against real attributes.
const POOL_SIZE = 6;
async function readAll(
  cc: CloudControlClient,
  targets: DesiredResource[],
  region: string,
  desired: Desired,
  reads: Map<string, ReadResult>
): Promise<void> {
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
}

interface ClassifyOpts {
  accountId: string;
  region: string;
  kmsAliasTargets: Record<string, string>;
  oaiCanonicalIds: Record<string, string>;
}

// CloudFront legacy OAI id -> S3CanonicalUserId, harvested from the stack's own
// OAI resources' live attributes (both are readOnly attrs the CC-API read already
// returned — no extra AWS call). Lets classify reconcile the two equivalent OAI
// principal forms in a resource policy (see rewriteOaiPrincipalsDeep). Empty when
// the stack declares no OAI.
const OAI_TYPE = 'AWS::CloudFront::CloudFrontOriginAccessIdentity';
function buildOaiCanonicalIds(desired: Desired): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== OAI_TYPE) continue;
    const live = desired.ctx.liveAttrs[r.logicalId];
    const id = live?.Id;
    const canonical = live?.S3CanonicalUserId;
    if (typeof id === 'string' && id && typeof canonical === 'string' && canonical) {
      map[id] = canonical;
    }
  }
  return map;
}

// Turn ONE resource's read into findings: no-physical-id / deleted / skipped
// short-circuits, else schema-strip + classify. Shared by gather's pass 2 and
// the scoped post-revert re-check (regatherTouched).
async function classifyRead(
  cfn: CloudFormationClient,
  r: DesiredResource,
  read: ReadResult | undefined,
  schemas: Map<string, SchemaInfo>,
  classifyOpts: ClassifyOpts
): Promise<Finding[]> {
  if (!r.physicalId) {
    return [
      {
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: 'no physical id',
      },
    ];
  }
  if (read?.deleted) {
    return [
      {
        tier: 'deleted',
        logicalId: r.logicalId,
        physicalId: r.physicalId,
        constructPath: r.constructPath,
        resourceType: r.resourceType,
        path: '',
        note: 'resource deleted out of band',
      },
    ];
  }
  if (!read || read.skippedReason || !read.live) {
    return [
      {
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: read?.skippedReason ?? 'not readable',
      },
    ];
  }
  const schema = schemas.get(r.resourceType) ?? (await getSchemaInfo(cfn, r.resourceType));
  schemas.set(r.resourceType, schema);
  return classifyResource(r, read.live, schema, classifyOpts);
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
  // Pass-2 ordering stays deterministic (iterates desired.resources).
  const reads = new Map<string, ReadResult>();
  const targets = desired.resources.filter((r) => r.physicalId);
  await readAll(cc, targets, region, desired, reads);

  // Re-resolve EVERY resource's declared now that pass 1 populated all live
  // attributes, so Fn::GetAtt resolves. Hoisted out of pass 2 because pass 1.5
  // (below) needs the resolved declared. Mutated in place so downstream consumers
  // (revert / record) see the resolved view.
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
  await readAll(cc, retryTargets, region, desired, reads);

  // KMS managed-alias resolution (R9): only if the stack declares any `alias/aws/*`,
  // fetch alias -> target key id once so classify can tell a managed-default key from
  // a customer-managed key swapped in out of band. Missing kms:ListAliases -> empty +
  // denied (the classifier falls back to the conservative shape-based match) — and we
  // WARN once per region, because that fallback is BLIND to a customer-key swap (R115).
  let kmsAliasTargets: Record<string, string> = {};
  if (desired.resources.some((r) => usesManagedKmsAlias(r.declared))) {
    const resolved = await fetchManagedAliasTargets(region);
    kmsAliasTargets = resolved.targets;
    if (resolved.denied && !kmsDeniedWarned.has(region)) {
      kmsDeniedWarned.add(region);
      console.error(kmsListAliasesDeniedWarning(region));
    }
  }
  const oaiCanonicalIds = buildOaiCanonicalIds(desired);
  const classifyOpts = { accountId: desired.accountId, region, kmsAliasTargets, oaiCanonicalIds };

  // Pass 2: classify (declared already re-resolved + override retries applied above).
  // CDKRD_CORPUS_DIR records every readable resource as a golden-corpus case
  // (the pure pipeline inputs + the findings they produced) for offline replay —
  // see src/corpus/record.ts (R63). Account ids are sanitized at record time.
  const corpusDir = process.env[CORPUS_DIR_ENV];
  for (const r of desired.resources) {
    const resourceFindings = await classifyRead(
      cfn,
      r,
      reads.get(r.logicalId),
      schemas,
      classifyOpts
    );
    findings.push(...resourceFindings);
    const live = reads.get(r.logicalId)?.live;
    const schema = schemas.get(r.resourceType);
    if (corpusDir && live && schema) {
      await recordCorpusCase(
        corpusDir,
        buildCorpusCase(r, live, schema, classifyOpts, resourceFindings)
      );
    }
  }
  return { desired, findings, schemas, liveByLogical: liveModelMap(reads) };
}

/**
 * Scoped re-gather for the post-revert convergence check (R44): re-read and
 * re-classify ONLY the `touched` resources, carrying every other resource's
 * findings forward from the original gather unchanged. The deployed template
 * cannot have changed (revert writes live state, not CloudFormation), so
 * `gathered.desired` and `gathered.schemas` stay valid — this turns a
 * whole-stack re-gather (template fetch + a live read per resource) into a
 * handful of reads, which is what made `revert` hang silently after the last
 * `reverted:` line. Out-of-band changes to UNTOUCHED resources during the
 * revert are deliberately not picked up — that is `check`'s job, and the old
 * full re-gather could even contradict the plan the user just confirmed by
 * blaming unrelated new drift on the revert.
 *
 * Returned findings are unordered across resources (untouched first, then the
 * fresh ones) — the convergence check only counts drift, it never renders them.
 * Mutates `gathered` the same way gatherFindings does (ctx.liveAttrs, resolved
 * declared, schemas cache).
 */
export async function regatherTouched(
  gathered: GatherResult,
  touched: Set<string>,
  region: string
): Promise<Finding[]> {
  const cfn = new CloudFormationClient({ region, ...READ_RETRY });
  const cc = new CloudControlClient({ region, ...READ_RETRY });
  const { desired, schemas } = gathered;
  const targets = desired.resources.filter((r) => touched.has(r.logicalId));

  const reads = new Map<string, ReadResult>();
  await readAll(
    cc,
    targets.filter((r) => r.physicalId),
    region,
    desired,
    reads
  );
  // Re-resolve declared against the refreshed liveAttrs (mirrors gather's hoisted
  // re-resolve) — GetAtt targets among the touched resources may have moved.
  for (const r of targets) {
    if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
  }
  // Re-check path (revert convergence): reuse the cached targets; the denial warning,
  // if any, already fired in the primary gather, so just take the resolved map.
  const kmsAliasTargets = targets.some((r) => usesManagedKmsAlias(r.declared))
    ? (await fetchManagedAliasTargets(region)).targets
    : {};
  // Built from desired.ctx.liveAttrs (populated by the original gather), so the OAI
  // map is complete even though regather only re-reads the touched resources.
  const oaiCanonicalIds = buildOaiCanonicalIds(desired);
  const classifyOpts = { accountId: desired.accountId, region, kmsAliasTargets, oaiCanonicalIds };

  const fresh: Finding[] = [];
  for (const r of targets) {
    fresh.push(...(await classifyRead(cfn, r, reads.get(r.logicalId), schemas, classifyOpts)));
  }
  // Refresh the live-model map for the re-read resources (so a follow-up tag-preserving
  // revert sees the post-revert managed-tag set), mirroring the findings carry-forward.
  for (const [logicalId, read] of reads)
    if (read.live) gathered.liveByLogical.set(logicalId, read.live);
  return [...gathered.findings.filter((f) => !touched.has(f.logicalId)), ...fresh];
}

// Builds the "declared desired" view of a deployed stack:
//   GetTemplate + ListStackResources (phys-id map, paginated) + DescribeStacks (params)
//   → intrinsic-resolve each resource's declared properties.
// Slice scope: JSON templates (CDK app output). YAML support is a follow-up.
import {
  type CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListExportsCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { classifyStackStatus, StackNotCheckableError } from '../aws-errors.js';
import { evalCondition, resolveProperties } from '../normalize/intrinsic-resolver.js';
import type { DesiredResource, ResolverContext } from '../types.js';
import { recoverNonAsciiMasks } from './recover-nonascii.js';
import { parseCfnTemplate } from './yaml-cfn.js';

export interface Desired {
  stackName: string;
  region: string;
  accountId: string;
  resources: DesiredResource[];
  rawTemplate: string; // verbatim deployed template body (for baseline templateHash)
  ctx: ResolverContext; // exposed so gather can re-resolve GetAtt once live attrs are read
  // set when the stack's StackStatus is mid-operation / failed (a comparison still runs
  // but results may be unreliable — check prints this). REVIEW_IN_PROGRESS / deleting
  // states never reach here: loadDesired throws StackNotCheckableError for those.
  stackStatusWarning?: string | undefined;
}

/** Parse a deployed template body (JSON or CFn-flavored YAML). */
export function parseTemplateBody(body: string): Record<string, unknown> {
  return parseCfnTemplate(body);
}

// The AWS::Partition / AWS::URLSuffix pseudo-parameters are a deterministic function of the
// region, NOT a commercial-partition constant. CDK env-agnostic stacks emit ${AWS::Partition}
// inside nearly every Sub/Join-built ARN, so hard-coding `aws` / `amazonaws.com` mis-resolves
// EVERY such declared ARN in GovCloud (`arn:aws-us-gov:...`) or China (`arn:aws-cn:...`) → a
// declared-tier FP on essentially every resource. Derive both from the region prefix (#730).
// Ordering note: `us-isob-` / `us-isof-` do not start with `us-iso-` (the char after `us-iso`
// is a letter, not `-`), so the `us-iso-` test does not swallow them; still, keep the more
// specific ISO prefixes listed for clarity.
function partitionForRegion(region: string): { partition: string; urlSuffix: string } {
  if (region.startsWith('us-gov-')) return { partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' };
  if (region.startsWith('cn-')) return { partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' };
  if (region.startsWith('us-iso-')) return { partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' };
  if (region.startsWith('us-isob-')) return { partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' };
  if (region.startsWith('us-isof-')) return { partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' };
  if (region.startsWith('eu-isoe-')) return { partition: 'aws-iso-e', urlSuffix: 'cloud.adc-e.uk' };
  return { partition: 'aws', urlSuffix: 'amazonaws.com' };
}

export function buildResolverContext(
  template: Record<string, any>,
  stackParams: Record<string, string>,
  physIds: Record<string, string>,
  region: string,
  accountId: string,
  stackName: string,
  stackId: string
): ResolverContext {
  // CommaDelimitedList / List<> params must resolve to ARRAYS so Fn::Join /
  // Fn::Select / conditions over them evaluate correctly (a string would break
  // Fn::Join and mis-evaluate conditions like HasTrustedAccounts).
  const paramDefs = (template.Parameters ?? {}) as Record<
    string,
    { Default?: unknown; Type?: string }
  >;
  const isList = (k: string): boolean => {
    const t = paramDefs[k]?.Type ?? '';
    return t === 'CommaDelimitedList' || t.startsWith('List<');
  };
  // CommaDelimitedList values are whitespace-trimmed by CloudFormation
  // ("a, b , c" -> ["a","b","c"]); mirror that so a Fn::Select / membership test
  // over the list matches the deployed-resource value (untrimmed " b" would FP).
  const toParam = (k: string, raw: string): string | string[] =>
    isList(k) ? (raw === '' ? [] : raw.split(',').map((s) => s.trim())) : raw;
  const params: Record<string, string | string[]> = {};
  for (const [k, def] of Object.entries(paramDefs)) {
    if (def && 'Default' in def) params[k] = toParam(k, String(def.Default));
  }
  for (const [k, v] of Object.entries(stackParams)) params[k] = toParam(k, v); // deployed values win
  // logicalId -> type and -> raw declared Properties, for resolveGetAtt's
  // declared-property-mirroring attributes (GETATT_DECLARED_PROPERTY).
  const templateResources = (template.Resources ?? {}) as Record<
    string,
    { Type?: string; Properties?: Record<string, unknown> }
  >;
  const typeOf: Record<string, string> = {};
  const declaredRawProps: Record<string, Record<string, unknown>> = {};
  for (const [lid, res] of Object.entries(templateResources)) {
    if (res?.Type) typeOf[lid] = res.Type;
    if (res?.Properties) declaredRawProps[lid] = res.Properties;
  }
  const { partition, urlSuffix } = partitionForRegion(region);
  return {
    params,
    pseudo: {
      'AWS::Region': region,
      'AWS::AccountId': accountId,
      'AWS::Partition': partition,
      'AWS::URLSuffix': urlSuffix,
      'AWS::StackName': stackName,
      'AWS::StackId': stackId,
    },
    conditions: template.Conditions ?? {},
    physIds,
    liveAttrs: {},
    typeOf,
    declaredRawProps,
    mappings: template.Mappings ?? {},
    exports: {}, // populated by loadDesired's prefetch only when the template references Fn::ImportValue
    condCache: new Map(),
  };
}

// Per-region cache of CFn exports (Name -> Value). Listing exports is account+region
// scoped, so a single fetch serves every ImportValue in the stack; cache so repeated
// gather runs in the same process don't re-page.
const exportsCache = new Map<string, Record<string, string>>();

async function listExports(
  client: CloudFormationClient,
  region: string
): Promise<Record<string, string>> {
  const cached = exportsCache.get(region);
  if (cached) return cached;
  const exports: Record<string, string> = {};
  let next: string | undefined;
  do {
    const res = await client.send(new ListExportsCommand({ NextToken: next }));
    for (const e of res.Exports ?? []) if (e.Name) exports[e.Name] = e.Value ?? '';
    next = res.NextToken;
  } while (next);
  exportsCache.set(region, exports);
  return exports;
}

// Page ListStackResources (DescribeStackResources caps at 100; CDK stacks reach ~500).
async function listStackResources(
  client: CloudFormationClient,
  stackName: string
): Promise<{ physIds: Record<string, string>; typeOf: Record<string, string> }> {
  const physIds: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListStackResourcesCommand({ StackName: stackName, NextToken: next })
    );
    for (const r of res.StackResourceSummaries ?? []) {
      if (r.LogicalResourceId && r.PhysicalResourceId)
        physIds[r.LogicalResourceId] = r.PhysicalResourceId;
      if (r.LogicalResourceId && r.ResourceType) typeOf[r.LogicalResourceId] = r.ResourceType;
    }
    next = res.NextToken;
  } while (next);
  return { physIds, typeOf };
}

export async function loadDesired(
  client: CloudFormationClient,
  stackName: string,
  region: string,
  // when provided (--pre-deploy), this LOCAL synth template is the declared source
  // instead of the deployed GetTemplate; physIds + params still come from the live stack
  templateOverride?: Record<string, unknown>,
  // the LOCAL synth template, used ONLY to recover non-ASCII string literals that
  // GetTemplate masked as `?` (see recoverNonAsciiMasks). Unlike templateOverride it does
  // NOT replace the declared source — it patches only the mask-matching corrupted leaves.
  recoveryTemplate?: Record<string, unknown>
): Promise<Desired> {
  // GetTemplate + DescribeStacks are single calls (kept in Promise.all); ListStackResources
  // is paginated separately (DescribeStackResources caps at 100, CDK stacks reach ~500).
  const [tmplRes, stkRes, { physIds }] = await Promise.all([
    templateOverride
      ? Promise.resolve({ TemplateBody: undefined })
      : client.send(new GetTemplateCommand({ StackName: stackName })),
    client.send(new DescribeStacksCommand({ StackName: stackName })),
    listStackResources(client, stackName),
  ]);
  const stack = stkRes.Stacks?.[0];
  // Stack-state gate — runs BEFORE the template is parsed: a REVIEW_IN_PROGRESS stack
  // (a change set created but never deployed) returns an EMPTY GetTemplate body, which
  // would otherwise blow up parseTemplateBody with "Unexpected end of JSON input". Skip
  // a stack with no meaningful deployed reality (REVIEW_IN_PROGRESS / deleting) rather
  // than silently compare live state against a never-deployed template; carry a warning
  // for mid-operation / failed states. Skipped under --pre-deploy (the declared source
  // is the LOCAL synth, not the deployed stack).
  const stateClass = templateOverride
    ? ({ kind: 'ok', message: '' } as const)
    : classifyStackStatus(stack?.StackStatus);
  if (stateClass.kind === 'skip') throw new StackNotCheckableError(stateClass.message);
  const stackStatusWarning = stateClass.kind === 'warn' ? stateClass.message : undefined;
  const template = (templateOverride ?? parseTemplateBody(tmplRes.TemplateBody ?? '{}')) as Record<
    string,
    any
  >;
  // Recover GetTemplate's `?`-masked non-ASCII literals from the local synth template
  // (mask-gated, per leaf). Skipped under --pre-deploy: there the declared source already
  // IS the intact synth template, so there is nothing to recover.
  if (!templateOverride && recoveryTemplate) recoverNonAsciiMasks(template, recoveryTemplate);
  const rawTemplate = templateOverride
    ? JSON.stringify(templateOverride)
    : (tmplRes.TemplateBody ?? '{}');
  const stackId = stack?.StackId ?? '';
  const accountId = stackId.split(':')[4] ?? '';

  const stackParams: Record<string, string> = {};
  for (const p of stack?.Parameters ?? []) {
    if (!p.ParameterKey) continue;
    // SSM-typed params (Type: AWS::SSM::Parameter::Value<...>) carry the raw SSM
    // KEY in ParameterValue and the dereferenced value in ResolvedValue — prefer
    // ResolvedValue so Ref resolves to what AWS actually deployed, not the key.
    const value = p.ResolvedValue ?? p.ParameterValue ?? '';
    // A NoEcho parameter is returned MASKED as '****'. Comparing against the mask
    // would be a false positive, so skip it entirely: the param drops out of ctx,
    // Ref resolves UNRESOLVED, and the dependent property is skipped (not compared)
    // — same treatment as a dynamic reference we cannot resolve.
    if (value === '****') continue;
    stackParams[p.ParameterKey] = value;
  }

  const ctx = buildResolverContext(
    template,
    stackParams,
    physIds,
    region,
    accountId,
    stackName,
    stackId
  );

  // Fn::ImportValue is synchronous in the resolver, so prefetch exports here — but
  // ONLY when the template actually references it, so normal stacks pay nothing for the
  // extra ListExports call(s). Gate on the PARSED template, NOT the raw body: a YAML
  // deployed template carries the short-form `!ImportValue` tag, so a substring check on
  // the raw body would miss it and leave exports unfetched — the import then resolves
  // UNRESOLVED and its declared property is silently skipped (missed drift).
  // parseTemplateBody has already normalized short-form tags to long-form `Fn::ImportValue`.
  if (JSON.stringify(template).includes('Fn::ImportValue')) {
    ctx.exports = await listExports(client, region);
  }

  const resources: DesiredResource[] = [];
  // IAM principals (Role / User / Group) whose inline Policies are managed by SIBLING
  // AWS::IAM::Policy resources (the CDK pattern). classify uses the per-principal POLICY
  // NAMES to drop only the sibling-owned live entries — an out-of-band inline policy still
  // surfaces.
  const principalsWithSiblingPolicy = collectPrincipalsWithSiblingPolicies(
    template.Resources ?? {},
    ctx
  );
  // ECS Cluster logicalIds whose CapacityProviders / DefaultCapacityProviderStrategy are
  // declared by a sibling AWS::ECS::ClusterCapacityProviderAssociations resource (the only
  // CFn way to set them). classify drops those reflected live props on the flagged cluster.
  const clustersWithSiblingCapacityProviders = collectClustersWithSiblingCapacityProviders(
    template.Resources ?? {}
  );

  for (const [logicalId, res] of Object.entries(
    (template.Resources ?? {}) as Record<string, any>
  )) {
    if (res.Type === 'AWS::CDK::Metadata') continue;
    // A resource guarded by a template `Condition:` that evaluates definitively FALSE is
    // never created by CloudFormation (the raw-CFn multi-env staple — one template serving
    // dev/prod). It has no physical id and no live counterpart to compare, so pushing it
    // would make classifyRead tag it a permanent `skipped: no physical id` — false
    // "coverage incomplete" noise that also keeps `check --strict` red forever, with
    // nothing the user can do in-tool. Drop it (matching CloudFormation's own semantics:
    // the resource is not part of the stack). Gate on "condition FALSE **and** no physical
    // id" so the fold is strictly noise-only: an UNRESOLVED or TRUE condition keeps today's
    // conservative behavior, and a false condition that somehow has a physical id (a CFn
    // anomaly) still surfaces.
    if (typeof res.Condition === 'string' && !physIds[logicalId]) {
      if (evalCondition(res.Condition, ctx) === false) continue;
    }
    const cdkPath = res.Metadata?.['aws:cdk:path'];
    const declaredRaw = (res.Properties ?? {}) as Record<string, unknown>;
    resources.push({
      logicalId,
      resourceType: res.Type as string,
      physicalId: physIds[logicalId],
      constructPath: typeof cdkPath === 'string' ? prettyConstructPath(cdkPath) : undefined,
      // first-pass resolution (no live attrs yet → GetAtt is UNRESOLVED). gather
      // re-resolves declaredRaw once liveAttrs is populated, reducing UNRESOLVED.
      declared: resolveProperties(declaredRaw, ctx),
      declaredRaw,
      siblingPolicyNames: IAM_PRINCIPAL_TYPES.has(res.Type)
        ? principalsWithSiblingPolicy.get(logicalId)
        : undefined,
      hasSiblingCapacityProviders:
        res.Type === 'AWS::ECS::Cluster'
          ? clustersWithSiblingCapacityProviders.has(logicalId)
          : undefined,
    });
  }
  return { stackName, region, accountId, resources, rawTemplate, ctx, stackStatusWarning };
}

// The IAM principal types an AWS::IAM::Policy can attach an inline policy to, via its
// Roles / Users / Groups reference lists (the CDK `<Principal>DefaultPolicy` pattern).
const IAM_PRINCIPAL_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::IAM::Group',
]);

// CDK construct paths end in "/Resource" for the L1 node; drop it for readability
// (e.g. "MyStack/Bucket/Resource" -> "MyStack/Bucket").
function prettyConstructPath(p: string): string {
  return p.endsWith('/Resource') ? p.slice(0, -'/Resource'.length) : p;
}

/**
 * Map each IAM principal logicalId (Role / User / Group) to the PolicyNames of the
 * sibling AWS::IAM::Policy resources attached to it via its Roles / Users / Groups
 * reference lists. A sibling whose PolicyName cannot be resolved to a string (an
 * intrinsic the resolver can't evaluate) marks the principal 'unresolved' — classify
 * then falls back to suppressing the whole live Policies property rather than risk a
 * false positive on the unidentifiable sibling entry.
 */
export function collectPrincipalsWithSiblingPolicies(
  resources: Record<string, any>,
  ctx?: ResolverContext
): Map<string, string[] | 'unresolved'> {
  const principals = new Map<string, string[] | 'unresolved'>();
  // Register one inline-policy sibling: attach `name` (resolved PolicyName) to each
  // principal logicalId in `refs`. An unresolvable PolicyName marks the principal
  // 'unresolved' (classify then suppresses the whole live Policies property).
  const attach = (name: string | undefined, refs: unknown[]) => {
    for (const r of refs) {
      const ref = r && typeof r === 'object' ? (r as Record<string, unknown>).Ref : undefined;
      if (typeof ref !== 'string') continue;
      const prev = principals.get(ref);
      if (prev === 'unresolved') continue;
      if (name === undefined) principals.set(ref, 'unresolved');
      else principals.set(ref, [...(prev ?? []), name]);
    }
  };
  for (const res of Object.values(resources)) {
    const name = resolvePolicyName(res?.Properties?.PolicyName, ctx);
    if (res?.Type === 'AWS::IAM::Policy') {
      // Array reference props: attach the same inline policy to every referenced principal.
      attach(name, [
        ...((res.Properties?.Roles ?? []) as unknown[]),
        ...((res.Properties?.Users ?? []) as unknown[]),
        ...((res.Properties?.Groups ?? []) as unknown[]),
      ]);
    } else {
      // Standalone inline-policy types attach to a SINGLE principal via a singular
      // RoleName / UserName / GroupName (a Ref/GetAtt to the principal, or a literal
      // name). Only a Ref maps to a principal logicalId — resolve exactly like the
      // Policy array entries (a literal name has no logicalId, so it is ignored).
      const singular = IAM_STANDALONE_INLINE_POLICY_TYPES.get(res?.Type);
      if (singular !== undefined) attach(name, [res?.Properties?.[singular]]);
    }
  }
  return principals;
}

// The standalone inline-policy resource types, mapped to the singular property that
// references their one attached principal. Each is the CDK `CfnRolePolicy` /
// `CfnUserPolicy` / `CfnGroupPolicy` equivalent of an inline policy on the principal.
const IAM_STANDALONE_INLINE_POLICY_TYPES: ReadonlyMap<string, string> = new Map([
  ['AWS::IAM::RolePolicy', 'RoleName'],
  ['AWS::IAM::UserPolicy', 'UserName'],
  ['AWS::IAM::GroupPolicy', 'GroupName'],
]);

/**
 * The set of ECS Cluster logicalIds that a sibling AWS::ECS::ClusterCapacityProviderAssociations
 * resource references (via its `Cluster: { Ref }`). CapacityProviders and
 * DefaultCapacityProviderStrategy can only be set through that separate resource — the Cluster's
 * own schema has no such property — so the association reflects them into the cluster's live model
 * where they read as false undeclared drift. The association is tracked + compared as its own
 * resource, so classify drops the reflected props on a flagged cluster.
 */
export function collectClustersWithSiblingCapacityProviders(
  resources: Record<string, any>
): Set<string> {
  const clusters = new Set<string>();
  for (const res of Object.values(resources)) {
    if (res?.Type !== 'AWS::ECS::ClusterCapacityProviderAssociations') continue;
    const ref = res.Properties?.Cluster?.Ref;
    if (typeof ref === 'string') clusters.add(ref);
  }
  return clusters;
}

// CDK emits literal PolicyNames (e.g. "RoleDefaultPolicyABC123"); hand-written
// templates may use intrinsics, which we resolve when a ctx is available.
function resolvePolicyName(raw: unknown, ctx?: ResolverContext): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null || !ctx) return undefined;
  const resolved = resolveProperties({ PolicyName: raw }, ctx).PolicyName;
  return typeof resolved === 'string' ? resolved : undefined; // UNRESOLVED is a symbol, never a string
}

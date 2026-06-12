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
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import type { DesiredResource, ResolverContext } from '../types.js';
import { parseCfnTemplate } from './yaml-cfn.js';

export interface Desired {
  stackName: string;
  region: string;
  accountId: string;
  resources: DesiredResource[];
  rawTemplate: string; // verbatim deployed template body (for baseline templateHash)
  ctx: ResolverContext; // exposed so gather can re-resolve GetAtt once live attrs are read
}

/** Parse a deployed template body (JSON or CFn-flavored YAML). */
export function parseTemplateBody(body: string): Record<string, unknown> {
  return parseCfnTemplate(body);
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
  const toParam = (k: string, raw: string): string | string[] =>
    isList(k) ? (raw === '' ? [] : raw.split(',')) : raw;
  const params: Record<string, string | string[]> = {};
  for (const [k, def] of Object.entries(paramDefs)) {
    if (def && 'Default' in def) params[k] = toParam(k, String(def.Default));
  }
  for (const [k, v] of Object.entries(stackParams)) params[k] = toParam(k, v); // deployed values win
  return {
    params,
    pseudo: {
      'AWS::Region': region,
      'AWS::AccountId': accountId,
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': stackName,
      'AWS::StackId': stackId,
    },
    conditions: template.Conditions ?? {},
    physIds,
    liveAttrs: {},
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
  templateOverride?: Record<string, unknown>
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
  const template = (templateOverride ?? parseTemplateBody(tmplRes.TemplateBody ?? '{}')) as Record<
    string,
    any
  >;
  const rawTemplate = templateOverride
    ? JSON.stringify(templateOverride)
    : (tmplRes.TemplateBody ?? '{}');
  const stack = stkRes.Stacks?.[0];
  const stackId = stack?.StackId ?? '';
  const accountId = stackId.split(':')[4] ?? '';

  const stackParams: Record<string, string> = {};
  for (const p of stack?.Parameters ?? [])
    if (p.ParameterKey) stackParams[p.ParameterKey] = p.ParameterValue ?? '';

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
  // ONLY when the template actually references it (a substring check on the body),
  // so normal stacks pay nothing for the extra ListExports call(s).
  const templateBody = templateOverride ? JSON.stringify(templateOverride) : rawTemplate;
  if (templateBody.includes('Fn::ImportValue')) {
    ctx.exports = await listExports(client, region);
  }

  const resources: DesiredResource[] = [];
  // Roles whose inline Policies are managed by SIBLING AWS::IAM::Policy resources
  // (the CDK pattern). classify uses the per-role POLICY NAMES to drop only the
  // sibling-owned live entries — an out-of-band inline policy still surfaces.
  const rolesWithSiblingPolicy = collectRolesWithSiblingPolicies(template.Resources ?? {}, ctx);

  for (const [logicalId, res] of Object.entries(
    (template.Resources ?? {}) as Record<string, any>
  )) {
    if (res.Type === 'AWS::CDK::Metadata') continue;
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
      siblingPolicyNames:
        res.Type === 'AWS::IAM::Role' ? rolesWithSiblingPolicy.get(logicalId) : undefined,
    });
  }
  return { stackName, region, accountId, resources, rawTemplate, ctx };
}

// CDK construct paths end in "/Resource" for the L1 node; drop it for readability
// (e.g. "MyStack/Bucket/Resource" -> "MyStack/Bucket").
function prettyConstructPath(p: string): string {
  return p.endsWith('/Resource') ? p.slice(0, -'/Resource'.length) : p;
}

/**
 * Map each role logicalId to the PolicyNames of the sibling AWS::IAM::Policy
 * resources attached to it. A sibling whose PolicyName cannot be resolved to a
 * string (an intrinsic the resolver can't evaluate) marks the role 'unresolved' —
 * classify then falls back to suppressing the whole live Policies property rather
 * than risk a false positive on the unidentifiable sibling entry.
 */
export function collectRolesWithSiblingPolicies(
  resources: Record<string, any>,
  ctx?: ResolverContext
): Map<string, string[] | 'unresolved'> {
  const roles = new Map<string, string[] | 'unresolved'>();
  for (const res of Object.values(resources)) {
    if (res?.Type !== 'AWS::IAM::Policy') continue;
    const name = resolvePolicyName(res.Properties?.PolicyName, ctx);
    for (const r of (res.Properties?.Roles ?? []) as unknown[]) {
      const ref = r && typeof r === 'object' ? (r as Record<string, unknown>).Ref : undefined;
      if (typeof ref !== 'string') continue;
      const prev = roles.get(ref);
      if (prev === 'unresolved') continue;
      if (name === undefined) roles.set(ref, 'unresolved');
      else roles.set(ref, [...(prev ?? []), name]);
    }
  }
  return roles;
}

// CDK emits literal PolicyNames (e.g. "RoleDefaultPolicyABC123"); hand-written
// templates may use intrinsics, which we resolve when a ctx is available.
function resolvePolicyName(raw: unknown, ctx?: ResolverContext): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null || !ctx) return undefined;
  const resolved = resolveProperties({ PolicyName: raw }, ctx).PolicyName;
  return typeof resolved === 'string' ? resolved : undefined; // UNRESOLVED is a symbol, never a string
}

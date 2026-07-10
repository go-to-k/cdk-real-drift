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

// #883: under --pre-deploy the declared source is the LOCAL synth template, so the
// symmetric half of "resource in the template but not yet deployed" is "resource DEPLOYED
// but absent from the template" — a live resource the next deploy will DELETE (a rename
// X->Y, or a construct removed from the app). loadDesired iterates only template Resources,
// so those deployed-only logical ids are otherwise invisible: the report shows the new
// resource as pending creation and says NOTHING about the one being torn down (often a
// stateful resource). Compute it from physIds (the live stack's resources) minus the local
// template's logical ids — zero extra AWS calls. Returns the info line, or null when none.
// Pure + exported for unit tests.
export function deletedResourceInfo(
  physIds: Record<string, string>,
  template: Record<string, unknown>,
  stackName: string
): string | null {
  const templateIds = new Set(Object.keys((template.Resources ?? {}) as Record<string, unknown>));
  const deleted = Object.keys(physIds)
    .filter((id) => !templateIds.has(id))
    .sort();
  if (deleted.length === 0) return null;
  const shown = deleted.slice(0, 10);
  const more = deleted.length > shown.length ? `, …(+${deleted.length - shown.length} more)` : '';
  return `info: ${stackName}: ${deleted.length} deployed resource(s) absent from the local template — the next deploy will DELETE them: ${shown.join(', ')}${more}`;
}

// #882: under --pre-deploy the declared type at a logical id comes from the LOCAL synth
// template, while physIds + deployedTypeOf come from the deployed stack. Swapping a construct
// at the SAME construct path (`new sqs.Queue(this,'X')` -> `new sns.Topic(this,'X')`) keeps
// the logical id but changes the Type. Attaching the deployed QUEUE's physical id to a
// DesiredResource of the new TOPIC type makes the live read do
// GetResource(TypeName=<new>, Identifier=<old-queue-id>) -> not-found -> a FALSE "resource
// deleted out of band". In reality the next deploy will REPLACE the resource (delete the old,
// create the new). Detect it (template type != deployed type at the same logical id) so the
// caller can (a) withhold the stale physical id and (b) surface a "will REPLACE" note instead
// of a false deletion. Returns the changed logical ids (sorted) — pure + exported for tests.
export function typeChangedResources(
  templateResources: Record<string, { Type?: string }>,
  deployedTypeOf: Record<string, string>
): string[] {
  return Object.entries(templateResources)
    .filter(([lid, res]) => {
      const declaredType = res?.Type;
      const deployedType = deployedTypeOf[lid];
      // both types must be known AND differ; an unknown deployed type (id not in the live
      // stack — a brand-new resource) is a normal creation, not a type change.
      return (
        typeof declaredType === 'string' &&
        typeof deployedType === 'string' &&
        declaredType !== deployedType
      );
    })
    .map(([lid]) => lid)
    .sort();
}

// Build the human-facing "this deploy will REPLACE" note for type-changed logical ids under
// --pre-deploy. Returns null when none changed. Pure + exported for unit tests.
export function typeChangeReplaceInfo(
  changed: string[],
  templateResources: Record<string, { Type?: string }>,
  deployedTypeOf: Record<string, string>,
  stackName: string
): string | null {
  if (changed.length === 0) return null;
  const shown = changed
    .slice(0, 10)
    .map((lid) => `${lid} (${deployedTypeOf[lid]} -> ${templateResources[lid]?.Type})`);
  const more = changed.length > shown.length ? `, …(+${changed.length - shown.length} more)` : '';
  return `info: ${stackName}: ${changed.length} resource(s) changed Type at the same logical id — the next deploy will REPLACE them (old resource deleted, new created): ${shown.join(', ')}${more}`;
}

// The AWS::Partition / AWS::URLSuffix pseudo-parameters are a deterministic function of the
// region, NOT a commercial-partition constant. CDK env-agnostic stacks emit ${AWS::Partition}
// inside nearly every Sub/Join-built ARN, so hard-coding `aws` / `amazonaws.com` mis-resolves
// EVERY such declared ARN in GovCloud (`arn:aws-us-gov:...`) or China (`arn:aws-cn:...`) → a
// declared-tier FP on essentially every resource. Derive both from the region prefix (#730).
// Ordering note: `us-isob-` / `us-isof-` do not start with `us-iso-` (the char after `us-iso`
// is a letter, not `-`), so the `us-iso-` test does not swallow them; still, keep the more
// specific ISO prefixes listed for clarity.
export function partitionForRegion(region: string): { partition: string; urlSuffix: string } {
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
  stackId: string,
  // #728: whether this is a --pre-deploy run (templateOverride set in loadDesired). It
  // flips the deployed-value overlay below: under --pre-deploy the declared source is the
  // LOCAL template, so a local param Default is authoritative and the deployed DescribeStacks
  // value only FILLS params that have no local Default (rather than overriding it). Defaults
  // to false — the deployed-path behaviour (deployed wins) — so existing non-pre-deploy
  // callers are unchanged.
  preDeploy = false
): ResolverContext {
  // CommaDelimitedList / List<> params must resolve to ARRAYS so Fn::Join /
  // Fn::Select / conditions over them evaluate correctly (a string would break
  // Fn::Join and mis-evaluate conditions like HasTrustedAccounts).
  const paramDefs = (template.Parameters ?? {}) as Record<
    string,
    { Default?: unknown; Type?: string; NoEcho?: unknown }
  >;
  const isList = (k: string): boolean => {
    const t = paramDefs[k]?.Type ?? '';
    // Plain list params AND SSM list-typed params. An SSM list param
    // (AWS::SSM::Parameter::Value<List<...>> / <CommaDelimitedList>) is returned by
    // DescribeStacks' ResolvedValue as a COMMA-JOINED string (AWS-documented), so it must
    // split to an array too — else declared "sg-a,sg-b" (string) vs live ["sg-a","sg-b"]
    // is a declared FP on every list-typed property fed by it, and an Fn::Select/Join over
    // it fails closed to UNRESOLVED (#745).
    return (
      t === 'CommaDelimitedList' ||
      t.startsWith('List<') ||
      t.includes('::Parameter::Value<List<') ||
      t.includes('::Parameter::Value<CommaDelimitedList')
    );
  };
  // CommaDelimitedList values are whitespace-trimmed by CloudFormation
  // ("a, b , c" -> ["a","b","c"]); mirror that so a Fn::Select / membership test
  // over the list matches the deployed-resource value (untrimmed " b" would FP).
  const toParam = (k: string, raw: string): string | string[] =>
    isList(k) ? (raw === '' ? [] : raw.split(',').map((s) => s.trim())) : raw;
  const params: Record<string, string | string[]> = {};
  for (const [k, def] of Object.entries(paramDefs)) {
    // A NoEcho parameter's template Default is a PLACEHOLDER (the raw-CFn/SAM
    // `Default: "changeme"` staple), NOT the real deployed secret. Seeding it makes every
    // property fed by the param a declared FP ("placeholder" vs the live secret) that
    // survives record and whose revert would OVERWRITE the live secret with the placeholder;
    // a Condition/Fn::If over it would also bake the wrong branch. The real deployed value
    // comes back masked '****' from DescribeStacks and is dropped in loadDesired, so skip the
    // Default too and let the param resolve UNRESOLVED (property skipped, conditions
    // fail-closed) — the same safe treatment as the masked deployed value (#744).
    if (def?.NoEcho === true || def?.NoEcho === 'true') continue;
    // An SSM-typed parameter (Type: AWS::SSM::Parameter::Value<...>) carries the SSM
    // parameter NAME/KEY in its Default, NOT the dereferenced value AWS will resolve at
    // deploy time. The deployed ResolvedValue (set below from DescribeStacks) is the real
    // value and overrides — but a parameter that is NEW in the LOCAL --pre-deploy template
    // has no deployed value yet, so seeding its Default would make Ref resolve to the KEY
    // string (`/golden/ami`) rather than the live value (`ami-0abc…`): a fabricated declared
    // FP, and the wrong literal fed into any Condition/Fn::If over it. Skip the Default and
    // let it resolve UNRESOLVED (property skipped, conditions fail-closed) — the same safe
    // treatment as a masked/unresolvable value; a deployed ResolvedValue still wins (#882).
    if ((def?.Type ?? '').includes('::Parameter::Value<')) continue;
    if (def && 'Default' in def) params[k] = toParam(k, String(def.Default));
  }
  if (preDeploy) {
    // #728: under --pre-deploy the declared source is the LOCAL template, so its param
    // Defaults are the values the next `cdk deploy` will apply. A DescribeStacks value is the
    // OLD deployed value (DescribeStacks returns an effective value for ALL params, including
    // default-materialized ones) — letting it override a CHANGED local Default masks exactly
    // the drift --pre-deploy exists to preview (the run reports CLEAN). So the local Default
    // wins; the deployed value only fills params with NO local Default (a required param set
    // at deploy time — we still need a value to resolve its Refs). NoEcho / SSM
    // `::Parameter::Value<` params were intentionally NOT seeded above, so they are absent
    // from `params` and still pick up their deployed value here (the fill step), preserving
    // their existing safe treatment.
    for (const [k, v] of Object.entries(stackParams)) {
      if (!(k in params)) params[k] = toParam(k, v);
    }
  } else {
    for (const [k, v] of Object.entries(stackParams)) params[k] = toParam(k, v); // deployed values win
  }
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

// Per-account+region cache of CFn exports (Name -> Value). CFn exports are scoped to
// an account AND a region, so the cache key MUST carry BOTH axes: keying on region
// alone would serve account A's exports to account B's same-region stack (a multi-account
// run) — a wrong-value resolution surfacing as a declared false positive / a wrong revert
// value. A single fetch serves every ImportValue in the stack; cache so repeated gather
// runs in the same process don't re-page.
const exportsCache = new Map<string, Record<string, string>>();

export async function listExports(
  client: CloudFormationClient,
  accountId: string,
  region: string
): Promise<Record<string, string>> {
  const cacheKey = `${accountId}:${region}`;
  const cached = exportsCache.get(cacheKey);
  if (cached) return cached;
  const exports: Record<string, string> = {};
  let next: string | undefined;
  do {
    const res = await client.send(new ListExportsCommand({ NextToken: next }));
    for (const e of res.Exports ?? []) if (e.Name) exports[e.Name] = e.Value ?? '';
    next = res.NextToken;
  } while (next);
  exportsCache.set(cacheKey, exports);
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
  const [tmplRes, stkRes, { physIds, typeOf: deployedTypeOf }] = await Promise.all([
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
  // for mid-operation / failed states.
  //
  // #882: this gate runs under --pre-deploy too. The templateOverride only substitutes the
  // DECLARED source (the local synth template replaces GetTemplate); physIds + every live
  // read still come from the DEPLOYED stack, so the deployed stack's state is just as
  // relevant. Skipping the gate under --pre-deploy meant a DELETE_IN_PROGRESS stack was
  // compared against half-deleted reality (red `deleted` findings), and a mid-operation /
  // failed stack proceeded with NO stackStatusWarning (always undefined). Keep the
  // classification. (REVIEW_IN_PROGRESS still returns an empty GetTemplate, but that body
  // is never parsed under --pre-deploy — it is skipped by the `skip` branch just the same.)
  const stateClass = classifyStackStatus(stack?.StackStatus);
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

  // #883: under --pre-deploy (templateOverride set), surface deployed resources that are
  // ABSENT from the local template — the next deploy will DELETE them. This is the symmetric
  // half of the #727 pending-creation note (which surfaces template resources not yet
  // deployed); together they answer "will this deploy fight reality?". stderr keeps --json
  // stdout clean, mirroring the #727 note in check.ts. Only meaningful pre-deploy: on the
  // deployed path the declared source IS the deployed template, so the two id sets match.
  if (templateOverride) {
    const deletedInfo = deletedResourceInfo(physIds, template, stackName);
    if (deletedInfo) console.error(deletedInfo);
  }

  // #882: detect logical ids whose Type changed between the deployed stack and the declared
  // template (a same-path construct swap under --pre-deploy). On the deployed path the declared
  // type IS the deployed type, so this set is always empty there — but compute unconditionally
  // and use it in the resource loop below to WITHHOLD the stale physical id (a phys id from the
  // OLD type can't be read as the NEW type → false "deleted out of band"). Under --pre-deploy,
  // also surface a "will REPLACE" note so the type change is not silently swallowed.
  const templateResourcesForTypeCheck = (template.Resources ?? {}) as Record<
    string,
    { Type?: string }
  >;
  const typeChanged = new Set(typeChangedResources(templateResourcesForTypeCheck, deployedTypeOf));
  if (templateOverride && typeChanged.size > 0) {
    const replaceInfo = typeChangeReplaceInfo(
      [...typeChanged].sort(),
      templateResourcesForTypeCheck,
      deployedTypeOf,
      stackName
    );
    if (replaceInfo) console.error(replaceInfo);
  }

  const ctx = buildResolverContext(
    template,
    stackParams,
    physIds,
    region,
    accountId,
    stackName,
    stackId,
    // #728: templateOverride set == --pre-deploy run. Pass it so a changed LOCAL param Default
    // wins over the OLD deployed value instead of being masked by it.
    !!templateOverride
  );

  // AWS::NotificationARNs is a LIST-valued pseudo-parameter that DescribeStacks already
  // returned above — plumb it so a `{ Ref: "AWS::NotificationARNs" }` (nested-stack /
  // alarm-action pattern) resolves instead of surfacing as a permanent `unresolved` footer
  // that also blocks `--strict`. It goes in `params` (which carries arrays) rather than the
  // scalar-typed `pseudo` map; resolveRef checks pseudo then params, and CFn reserves the
  // `AWS::` prefix so no user parameter can collide. Absent/empty → leave it unresolved (#746).
  const notificationArns = stack?.NotificationARNs ?? [];
  if (notificationArns.length > 0) ctx.params['AWS::NotificationARNs'] = notificationArns;

  // Fn::ImportValue is synchronous in the resolver, so prefetch exports here — but
  // ONLY when the template actually references it, so normal stacks pay nothing for the
  // extra ListExports call(s). Gate on the PARSED template, NOT the raw body: a YAML
  // deployed template carries the short-form `!ImportValue` tag, so a substring check on
  // the raw body would miss it and leave exports unfetched — the import then resolves
  // UNRESOLVED and its declared property is silently skipped (missed drift).
  // parseTemplateBody has already normalized short-form tags to long-form `Fn::ImportValue`.
  if (JSON.stringify(template).includes('Fn::ImportValue')) {
    // DEGRADE, don't die: a principal with cloudformation:GetTemplate + DescribeStacks but
    // NO cloudformation:ListExports would otherwise hard-fail the ENTIRE stack check (exit 2)
    // over a permission gap that affects only one resolution axis. A read-only check should
    // leave ctx.exports empty on failure — the ImportValue-consuming properties then resolve
    // to `unresolved` (visible, and blocks --strict) instead of taking down the whole stack.
    try {
      ctx.exports = await listExports(client, accountId, region);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `warning: ${stackName}: cloudformation:ListExports failed — Fn::ImportValue references ` +
          `will resolve UNRESOLVED (their declared properties are skipped, not compared). ` +
          `Grant cloudformation:ListExports for full coverage. (${msg})`
      );
    }
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
    // #882: withhold the physical id when the Type changed at this logical id — the deployed
    // phys id belongs to the OLD type and can't be GetResource'd as the NEW type. Leaving it
    // undefined makes the live read find nothing to fetch (the resource does not yet exist
    // under the new type), so classify tags it a normal pending create rather than emitting a
    // false "resource deleted out of band" (the note above already told the user it'll REPLACE).
    const physicalId = typeChanged.has(logicalId) ? undefined : physIds[logicalId];
    resources.push({
      logicalId,
      resourceType: res.Type as string,
      physicalId,
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

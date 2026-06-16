// Added-resource detection (the resource-granularity sibling of undeclared):
// for a DECLARED "parent" resource, enumerate its LIVE child resources and flag any
// that are NOT in the deployed template — a whole resource created out of band (e.g.
// an API Gateway Method added on the root `/` via the console). The per-type code is
// ONLY the child enumeration; the resulting `added` findings carry a Cloud Control
// identifier so a later `revert` can DeleteResource them generically (no per-type
// writer). Mirrors the SDK_OVERRIDES registry shape (one entry per parent type).
//
// Enumeration uses the SERVICE SDK, not Cloud Control ListResources: CC ListResources
// is UnsupportedAction for AWS::ApiGateway::Resource/Method (verified live), so a
// CC-based scan silently read back nothing. The same CC-gap reason SDK_OVERRIDES
// exists for reads. CC GetResource/DeleteResource on these types DO work, so the
// `identifier` stays the CC composite (`RestApiId|ResourceId[|HttpMethod]`) — that is
// what revert's DeleteResource consumes.
import {
  APIGatewayClient,
  GetResourcesCommand,
  type Resource as ApiGwResource,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetIntegrationsCommand,
  GetRoutesCommand,
  type Integration as ApiGwV2Integration,
  type Route as ApiGwV2Route,
} from '@aws-sdk/client-apigatewayv2';
import {
  EventBridgeClient,
  ListRulesCommand,
  type Rule as EventBridgeRule,
} from '@aws-sdk/client-eventbridge';
import {
  type EventSourceMappingConfiguration,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import {
  ListSubscriptionsByTopicCommand,
  SNSClient,
  type Subscription as SnsSubscription,
} from '@aws-sdk/client-sns';
import { READ_RETRY } from './client-config.js';
import type { Desired } from '../desired/template-adapter.js';
import type { DesiredResource } from '../types.js';

// One out-of-band child resource: present live, absent from the template.
export interface AddedChild {
  resourceType: string; // CC TypeName of the child (e.g. AWS::ApiGateway::Method)
  identifier: string; // CC primaryIdentifier — feeds GetResource / DeleteResource (revert)
  label: string; // human display (e.g. 'ANY /', '/widgets')
  live: Record<string, unknown>; // live model snippet, for the report `actual`
}

export interface EnumeratorContext {
  parent: DesiredResource; // the declared parent (its physicalId is the live parent id)
  desired: Desired; // full desired view — declared children + parent live attrs
  region: string;
}

export type ChildEnumerator = (ctx: EnumeratorContext) => Promise<AddedChild[]>;

// Registry: declared parent TYPE -> child enumerator. Grown one type at a time,
// exactly like SDK_OVERRIDES. API Gateway REST APIs were the first member; API Gateway
// V2 (HTTP / WebSocket) APIs the second; SNS Topics (subscriptions) the third; Lambda
// Functions (event source mappings) the fourth; EventBridge event buses (rules) the fifth.
export const CHILD_ENUMERATORS: Record<string, ChildEnumerator> = {
  'AWS::ApiGateway::RestApi': enumerateRestApiChildren,
  'AWS::ApiGatewayV2::Api': enumerateHttpApiChildren,
  'AWS::SNS::Topic': enumerateSnsTopicChildren,
  'AWS::Lambda::Function': enumerateLambdaFunctionChildren,
  'AWS::Events::EventBus': enumerateEventBusChildren,
};

// ── API Gateway ────────────────────────────────────────────────────────────
// A RestApi owns Resources (paths) and Methods. Both are separate CloudFormation
// resources, so the template lists every declared one; anything live but undeclared
// is an out-of-band addition. The root resource `/` is implicit (created with the
// RestApi) and so always counts as declared.

// Pure diff: given the declared child sets and the live inventory, return the added
// children. Separated from the SDK calls so the matching logic is unit-tested offline.
export interface ApiGatewayChildInput {
  apiId: string;
  rootResourceId?: string | undefined; // RestApi.RootResourceId (the `/` resource)
  declaredResourceIds: string[]; // physical ids of AWS::ApiGateway::Resource in the template
  declaredMethodKeys: string[]; // `${resourceId}|${httpMethod}` for each declared Method
  liveResources: { id: string; path?: string | undefined; live?: Record<string, unknown> }[];
  // resourceId -> live methods on it. Keyed so an added resource's methods are not
  // double-reported (we skip method scanning on a resource that is itself added).
  liveMethodsByResource: Record<string, { httpMethod: string; live?: Record<string, unknown> }[]>;
}

export function diffApiGatewayChildren(input: ApiGatewayChildInput): AddedChild[] {
  const {
    apiId,
    rootResourceId,
    declaredResourceIds,
    declaredMethodKeys,
    liveResources,
    liveMethodsByResource,
  } = input;
  // Declared = template resources + the implicit root. The root `/` resource is ALWAYS
  // created with the RestApi and is never an "added" out-of-band resource. Identify it
  // by its LIVE path '/' (authoritative) IN ADDITION to rootResourceId — the latter
  // comes from the RestApi's CC read (liveAttrs), which may be skipped / throttled /
  // missing the attr, leaving rootResourceId undefined. Without the path fallback the
  // live root would then be flagged `added`, and a `revert` would issue DeleteResource
  // against the API's ROOT resource — a destructive false positive.
  const liveRootId = liveResources.find((r) => r.path === '/')?.id;
  const declaredResources = new Set(declaredResourceIds);
  if (rootResourceId) declaredResources.add(rootResourceId);
  if (liveRootId) declaredResources.add(liveRootId);
  const declaredMethods = new Set(declaredMethodKeys);

  const pathOf = new Map<string, string>();
  for (const r of liveResources) pathOf.set(r.id, r.path ?? r.id);
  if (rootResourceId && !pathOf.has(rootResourceId)) pathOf.set(rootResourceId, '/');

  const added: AddedChild[] = [];
  const addedResourceIds = new Set<string>();
  for (const r of liveResources) {
    if (declaredResources.has(r.id)) continue;
    addedResourceIds.add(r.id);
    added.push({
      resourceType: 'AWS::ApiGateway::Resource',
      identifier: `${apiId}|${r.id}`,
      label: pathOf.get(r.id) ?? r.id,
      live: r.live ?? {},
    });
  }

  // Methods: a method on a resource that is ITSELF added comes with that resource —
  // report only the resource. On every other (declared or root) resource, an
  // undeclared method is its own added finding.
  for (const [resourceId, methods] of Object.entries(liveMethodsByResource)) {
    if (addedResourceIds.has(resourceId)) continue;
    // When rootResourceId is unresolved (RestApi read incomplete), the template's
    // root-method ResourceId (Fn::GetAtt RootResourceId) couldn't resolve, so
    // declaredMethodKeys is missing the root's DECLARED methods — skip method-diffing
    // the live root to avoid falsely flagging a declared root method as added.
    if (!rootResourceId && resourceId === liveRootId) continue;
    for (const m of methods) {
      if (declaredMethods.has(`${resourceId}|${m.httpMethod}`)) continue;
      added.push({
        resourceType: 'AWS::ApiGateway::Method',
        identifier: `${apiId}|${resourceId}|${m.httpMethod}`,
        label: `${m.httpMethod} ${pathOf.get(resourceId) ?? resourceId}`,
        live: m.live ?? {},
      });
    }
  }
  return added;
}

// Page GetResources (embed=methods returns every resource AND its methods in one
// paginated sweep — the root `/` resource included, so a method on root is caught).
async function getAllResources(client: APIGatewayClient, apiId: string): Promise<ApiGwResource[]> {
  const out: ApiGwResource[] = [];
  let position: string | undefined;
  do {
    const res = await client.send(
      new GetResourcesCommand({ restApiId: apiId, embed: ['methods'], limit: 500, position })
    );
    out.push(...(res.items ?? []));
    position = res.position;
  } while (position);
  return out;
}

async function enumerateRestApiChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const apiId = parent.physicalId;
  if (!apiId) return [];

  // RootResourceId is a readOnly attr already returned by the RestApi's CC read
  // (gather populated liveAttrs in pass 1); used to mark the `/` resource implicitly
  // declared even though GetResources also returns it.
  const restApiLive = desired.ctx.liveAttrs[parent.logicalId] ?? {};
  const rootResourceId =
    typeof restApiLive.RootResourceId === 'string' ? restApiLive.RootResourceId : undefined;

  // Declared children of THIS api (Ref/GetAtt already resolved to physical ids by gather).
  const declaredResourceIds: string[] = [];
  const declaredMethodKeys: string[] = [];
  for (const r of desired.resources) {
    if (r.declared.RestApiId !== apiId) continue;
    if (r.resourceType === 'AWS::ApiGateway::Resource' && r.physicalId) {
      declaredResourceIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::ApiGateway::Method') {
      const rid = r.declared.ResourceId;
      const hm = r.declared.HttpMethod;
      if (typeof rid === 'string' && typeof hm === 'string') {
        declaredMethodKeys.push(`${rid}|${hm}`);
      }
    }
  }

  const client = new APIGatewayClient({ region, ...READ_RETRY });
  const items = await getAllResources(client, apiId);
  const liveResources = items
    .filter((i): i is ApiGwResource & { id: string } => typeof i.id === 'string')
    .map((i) => ({ id: i.id, path: i.path, live: { Path: i.path, PathPart: i.pathPart } }));
  const liveMethodsByResource: Record<
    string,
    { httpMethod: string; live?: Record<string, unknown> }[]
  > = {};
  for (const i of items) {
    if (typeof i.id !== 'string') continue;
    liveMethodsByResource[i.id] = Object.keys(i.resourceMethods ?? {}).map((httpMethod) => ({
      httpMethod,
      live: { HttpMethod: httpMethod, ResourceId: i.id, Path: i.path },
    }));
  }

  return diffApiGatewayChildren({
    apiId,
    rootResourceId,
    declaredResourceIds,
    declaredMethodKeys,
    liveResources,
    liveMethodsByResource,
  });
}

// ── API Gateway V2 (HTTP / WebSocket) ────────────────────────────────────────
// An `AWS::ApiGatewayV2::Api` owns Routes and Integrations, each a SEPARATE
// CloudFormation resource — the direct V2 analogue of REST's Resources + Methods.
// A console-added Route (e.g. `GET /admin`) or Integration is invisible to `cdk drift`
// / CFn drift detection (they only compare template-declared resources). Unlike REST
// there is no implicit "root" child to special-case, and Routes/Integrations are
// siblings (not nested), so each is reported independently. Both protocol types (HTTP
// and WebSocket) use the same Api type + GetRoutes/GetIntegrations APIs, so one
// enumerator covers both. CC `GetResource`/`DeleteResource` consume the composite
// identifier (`ApiId|RouteId` / `ApiId|IntegrationId`), so revert deletes generically.

// Pure diff: declared child id sets + live inventory -> the added children. Separated
// from the SDK calls so the matching is unit-tested offline (mirrors REST).
export interface ApiGatewayV2ChildInput {
  apiId: string;
  declaredRouteIds: string[]; // physical ids of AWS::ApiGatewayV2::Route in the template
  declaredIntegrationIds: string[]; // physical ids of AWS::ApiGatewayV2::Integration
  liveRoutes: { id: string; key?: string | undefined }[];
  liveIntegrations: { id: string; label?: string | undefined }[];
}

export function diffApiGatewayV2Children(input: ApiGatewayV2ChildInput): AddedChild[] {
  const { apiId, declaredRouteIds, declaredIntegrationIds, liveRoutes, liveIntegrations } = input;
  const declaredRoutes = new Set(declaredRouteIds);
  const declaredIntegrations = new Set(declaredIntegrationIds);
  const added: AddedChild[] = [];
  for (const r of liveRoutes) {
    if (declaredRoutes.has(r.id)) continue;
    added.push({
      resourceType: 'AWS::ApiGatewayV2::Route',
      identifier: `${apiId}|${r.id}`,
      label: r.key ?? r.id, // RouteKey is the human form, e.g. 'GET /items' / '$default'
      live: { RouteId: r.id, RouteKey: r.key },
    });
  }
  for (const i of liveIntegrations) {
    if (declaredIntegrations.has(i.id)) continue;
    added.push({
      resourceType: 'AWS::ApiGatewayV2::Integration',
      identifier: `${apiId}|${i.id}`,
      label: i.label ?? i.id,
      live: { IntegrationId: i.id },
    });
  }
  return added;
}

// A readable label for an out-of-band Integration (no RouteKey-style human key): the
// integration type plus its target URI when present (e.g. 'AWS_PROXY arn:...:fn').
function integrationLabel(i: ApiGwV2Integration): string | undefined {
  if (!i.IntegrationType) return undefined;
  return i.IntegrationUri ? `${i.IntegrationType} ${i.IntegrationUri}` : i.IntegrationType;
}

async function pageRoutes(client: ApiGatewayV2Client, apiId: string): Promise<ApiGwV2Route[]> {
  const out: ApiGwV2Route[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new GetRoutesCommand({ ApiId: apiId, NextToken: next }));
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function pageIntegrations(
  client: ApiGatewayV2Client,
  apiId: string
): Promise<ApiGwV2Integration[]> {
  const out: ApiGwV2Integration[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new GetIntegrationsCommand({ ApiId: apiId, NextToken: next }));
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateHttpApiChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const apiId = parent.physicalId;
  if (!apiId) return [];

  // Declared children of THIS api (Ref/GetAtt ApiId already resolved to the physical id
  // by gather). Route/Integration physical ids ARE the RouteId/IntegrationId.
  const declaredRouteIds: string[] = [];
  const declaredIntegrationIds: string[] = [];
  for (const r of desired.resources) {
    if (r.declared.ApiId !== apiId) continue;
    if (r.resourceType === 'AWS::ApiGatewayV2::Route' && r.physicalId) {
      declaredRouteIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::ApiGatewayV2::Integration' && r.physicalId) {
      declaredIntegrationIds.push(r.physicalId);
    }
  }

  const client = new ApiGatewayV2Client({ region, ...READ_RETRY });
  const [routes, integrations] = await Promise.all([
    pageRoutes(client, apiId),
    pageIntegrations(client, apiId),
  ]);
  const liveRoutes = routes
    .filter((r): r is ApiGwV2Route & { RouteId: string } => typeof r.RouteId === 'string')
    .map((r) => ({ id: r.RouteId, key: r.RouteKey }));
  const liveIntegrations = integrations
    .filter(
      (i): i is ApiGwV2Integration & { IntegrationId: string } =>
        typeof i.IntegrationId === 'string'
    )
    .map((i) => ({ id: i.IntegrationId, label: integrationLabel(i) }));

  return diffApiGatewayV2Children({
    apiId,
    declaredRouteIds,
    declaredIntegrationIds,
    liveRoutes,
    liveIntegrations,
  });
}

// ── SNS ──────────────────────────────────────────────────────────────────────
// An `AWS::SNS::Topic` owns Subscriptions, each a separate CloudFormation resource.
// A console-added subscription (someone wires an email / SQS / Lambda endpoint to a
// topic out of band) is invisible to `cdk drift` / CFn drift detection. A topic has no
// AWS-auto-created subscriptions, so there is no implicit child to special-case (unlike
// REST's root resource). The CC primaryIdentifier for AWS::SNS::Subscription is the bare
// SubscriptionArn (not a composite), which CC GetResource / DeleteResource consume.

// Pure diff: declared subscription arns + live inventory -> the added subscriptions.
export interface SnsTopicChildInput {
  declaredSubscriptionArns: string[]; // physical ids of AWS::SNS::Subscription in the template
  liveSubscriptions: { arn: string; label?: string | undefined }[];
}

export function diffSnsTopicChildren(input: SnsTopicChildInput): AddedChild[] {
  const declared = new Set(input.declaredSubscriptionArns);
  const added: AddedChild[] = [];
  for (const s of input.liveSubscriptions) {
    if (declared.has(s.arn)) continue;
    added.push({
      resourceType: 'AWS::SNS::Subscription',
      identifier: s.arn, // SubscriptionArn IS the CC primaryIdentifier
      label: s.label ?? s.arn,
      live: { SubscriptionArn: s.arn },
    });
  }
  return added;
}

async function pageSubscriptions(client: SNSClient, topicArn: string): Promise<SnsSubscription[]> {
  const out: SnsSubscription[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: next })
    );
    out.push(...(res.Subscriptions ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateSnsTopicChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const topicArn = parent.physicalId; // the Topic's physical id IS its ARN
  if (!topicArn) return [];

  // Declared subscriptions of THIS topic (Ref/GetAtt TopicArn already resolved by gather).
  // A subscription's physical id IS its SubscriptionArn.
  const declaredSubscriptionArns: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::SNS::Subscription' &&
      r.declared.TopicArn === topicArn &&
      r.physicalId
    ) {
      declaredSubscriptionArns.push(r.physicalId);
    }
  }

  const client = new SNSClient({ region, ...READ_RETRY });
  const subs = await pageSubscriptions(client, topicArn);
  const liveSubscriptions = subs
    // Skip subscriptions with no real ARN: a pending-confirmation email/http sub reports
    // `PendingConfirmation` (and a just-deleted one `Deleted`) as its arn — neither is a
    // CC-addressable resource, so it cannot be recorded or reverted; not yet a real child.
    .filter(
      (s): s is SnsSubscription & { SubscriptionArn: string } =>
        typeof s.SubscriptionArn === 'string' && s.SubscriptionArn.startsWith('arn:')
    )
    .map((s) => ({
      arn: s.SubscriptionArn,
      label: s.Protocol ? `${s.Protocol} ${s.Endpoint ?? ''}`.trim() : s.SubscriptionArn,
    }));

  return diffSnsTopicChildren({ declaredSubscriptionArns, liveSubscriptions });
}

// ── Lambda ───────────────────────────────────────────────────────────────────
// A Lambda Function owns Event Source Mappings (the SQS / DynamoDB-stream / Kinesis /
// MSK poller wiring), each a separate CloudFormation resource. A console / CLI
// `create-event-source-mapping` (someone wires a new trigger to a function out of band)
// is invisible to cdk drift / CFn drift detection. The Function's own live model does
// NOT reflect its mappings, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::Lambda::EventSourceMapping is the bare mapping UUID (Id),
// which CC GetResource / DeleteResource consume.

// Pure diff: declared mapping ids + live inventory -> the added mappings.
export interface LambdaFunctionChildInput {
  declaredMappingIds: string[]; // physical ids (UUIDs) of AWS::Lambda::EventSourceMapping
  liveMappings: { id: string; label?: string | undefined }[];
}

export function diffLambdaFunctionChildren(input: LambdaFunctionChildInput): AddedChild[] {
  const declared = new Set(input.declaredMappingIds);
  const added: AddedChild[] = [];
  for (const m of input.liveMappings) {
    if (declared.has(m.id)) continue;
    added.push({
      resourceType: 'AWS::Lambda::EventSourceMapping',
      identifier: m.id, // the mapping UUID IS the CC primaryIdentifier
      label: m.label ?? m.id,
      live: { Id: m.id },
    });
  }
  return added;
}

async function pageEventSourceMappings(
  client: LambdaClient,
  functionName: string
): Promise<EventSourceMappingConfiguration[]> {
  const out: EventSourceMappingConfiguration[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new ListEventSourceMappingsCommand({ FunctionName: functionName, Marker: marker })
    );
    out.push(...(res.EventSourceMappings ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

async function enumerateLambdaFunctionChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const functionName = parent.physicalId; // the Function's physical id is its name
  if (!functionName) return [];

  // Declared mappings targeting THIS function. An EventSourceMapping's FunctionName is
  // often a Ref/GetAtt (already resolved by gather), and its physical id IS the mapping
  // UUID. Match on the function name resolving to either the bare name or its ARN.
  const fnArnRaw = desired.ctx.liveAttrs[parent.logicalId]?.Arn;
  const fnArn = typeof fnArnRaw === 'string' ? fnArnRaw : undefined;
  const declaredMappingIds: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Lambda::EventSourceMapping' || !r.physicalId) continue;
    const fn = r.declared.FunctionName;
    if (fn === functionName || (fnArn !== undefined && fn === fnArn)) {
      declaredMappingIds.push(r.physicalId);
    }
  }

  const client = new LambdaClient({ region, ...READ_RETRY });
  const mappings = await pageEventSourceMappings(client, functionName);
  const liveMappings = mappings
    .filter(
      (m): m is EventSourceMappingConfiguration & { UUID: string } => typeof m.UUID === 'string'
    )
    .map((m) => ({ id: m.UUID, label: m.EventSourceArn ?? m.UUID }));

  return diffLambdaFunctionChildren({ declaredMappingIds, liveMappings });
}

// ── EventBridge ────────────────────────────────────────────────────────────────
// An `AWS::Events::EventBus` owns Rules, each a separate CloudFormation resource. A
// console / CLI `put-rule` (someone wires a new rule on a custom bus out of band) is
// invisible to cdk drift / CFn drift detection. Only DECLARED custom buses are scanned,
// so the AWS-default bus (never a template resource) is never swept — its many
// AWS-created rules are out of scope. AWS service-managed rules (ManagedBy set) are
// skipped: they are owned by another service, not an out-of-band human change. The
// EventBus model does NOT reflect its rules, so there is no double-report to suppress.
// The CC primaryIdentifier for AWS::Events::Rule is the bare rule Arn, which CC
// GetResource / DeleteResource consume.

// Pure diff: declared rule names + live inventory -> the added rules.
export interface EventBusChildInput {
  declaredRuleNames: string[]; // bare Names of AWS::Events::Rule declared on this bus
  liveRules: { name: string; arn: string; label?: string | undefined }[];
}

export function diffEventBusChildren(input: EventBusChildInput): AddedChild[] {
  const declared = new Set(input.declaredRuleNames);
  const added: AddedChild[] = [];
  for (const r of input.liveRules) {
    if (declared.has(r.name)) continue;
    added.push({
      resourceType: 'AWS::Events::Rule',
      identifier: r.arn, // the rule Arn IS the CC primaryIdentifier
      label: r.label ?? r.name,
      live: { Name: r.name, Arn: r.arn },
    });
  }
  return added;
}

async function pageRules(client: EventBridgeClient, busName: string): Promise<EventBridgeRule[]> {
  const out: EventBridgeRule[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListRulesCommand({ EventBusName: busName, NextToken: next }));
    out.push(...(res.Rules ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateEventBusChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const busName = parent.physicalId; // an EventBus's physical id is its name
  if (!busName) return [];
  const busArnRaw = desired.ctx.liveAttrs[parent.logicalId]?.Arn;
  const busArn = typeof busArnRaw === 'string' ? busArnRaw : undefined;

  // Declared rules on THIS bus. EventBusName resolves (via gather) to either the bus name
  // or its ARN. A rule's physical id (Ref) is its name — but for a custom bus that can be
  // a `<busName>|<ruleName>` composite, so take the trailing segment; ListRules returns
  // the bare name. Fall back to a literal declared Name.
  const declaredRuleNames: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Events::Rule') continue;
    const bus = r.declared.EventBusName;
    if (bus !== busName && !(busArn !== undefined && bus === busArn)) continue;
    const raw = r.physicalId ?? (typeof r.declared.Name === 'string' ? r.declared.Name : undefined);
    if (raw) declaredRuleNames.push(raw.includes('|') ? raw.slice(raw.lastIndexOf('|') + 1) : raw);
  }

  const client = new EventBridgeClient({ region, ...READ_RETRY });
  const rules = await pageRules(client, busName);
  const liveRules = rules
    // Skip AWS service-managed rules (ManagedBy set): owned by another AWS service, not an
    // out-of-band human change, and not user-revertable.
    .filter(
      (r): r is EventBridgeRule & { Name: string; Arn: string } =>
        typeof r.Name === 'string' && typeof r.Arn === 'string' && !r.ManagedBy
    )
    .map((r) => ({ name: r.Name, arn: r.Arn, label: r.Name }));

  return diffEventBusChildren({ declaredRuleNames, liveRules });
}

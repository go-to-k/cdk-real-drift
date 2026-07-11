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
  type Authorizer as ApiGwAuthorizer,
  type GatewayResponse as ApiGwGatewayResponse,
  GetAuthorizersCommand,
  GetGatewayResponsesCommand,
  GetModelsCommand,
  GetRequestValidatorsCommand,
  GetResourcesCommand,
  GetStagesCommand as GetRestStagesCommand,
  type Model as ApiGwModel,
  type RequestValidator as ApiGwRequestValidator,
  type Resource as ApiGwResource,
  type Stage as ApiGwRestStage,
} from '@aws-sdk/client-api-gateway';
import {
  AppConfigClient,
  type ConfigurationProfileSummary as AppConfigConfigurationProfile,
  type Environment as AppConfigEnvironment,
  ListConfigurationProfilesCommand,
  ListEnvironmentsCommand,
} from '@aws-sdk/client-appconfig';
import {
  type ApiKey as AppSyncApiKey,
  AppSyncClient,
  type DataSource as AppSyncDataSource,
  type FunctionConfiguration as AppSyncFunctionConfiguration,
  ListApiKeysCommand,
  ListDataSourcesCommand,
  ListFunctionsCommand as ListAppSyncFunctionsCommand,
  ListResolversCommand,
  ListTypesCommand,
  type Resolver as AppSyncResolver,
} from '@aws-sdk/client-appsync';
import {
  ApiGatewayV2Client,
  type Authorizer as ApiGwV2Authorizer,
  GetAuthorizersCommand as GetV2AuthorizersCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetStagesCommand,
  type Integration as ApiGwV2Integration,
  type Route as ApiGwV2Route,
  type Stage as ApiGwV2Stage,
} from '@aws-sdk/client-apigatewayv2';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
  DescribeSubscriptionFiltersCommand,
  type MetricFilter as CwlMetricFilter,
  type SubscriptionFilter as CwlSubscriptionFilter,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CognitoIdentityProviderClient,
  type GroupType,
  ListGroupsCommand,
  ListIdentityProvidersCommand,
  ListResourceServersCommand,
  ListUserPoolClientsCommand,
  type ProviderDescription,
  type ResourceServerType,
  type UserPoolClientDescription,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DescribeInternetGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeRouteTablesCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type InternetGateway as Ec2InternetGateway,
  type NetworkAcl as Ec2NetworkAcl,
  type NetworkAclEntry as Ec2NetworkAclEntry,
  type Route as Ec2Route,
  type RouteTable as Ec2RouteTable,
  type RouteTableAssociation as Ec2RouteTableAssociation,
  type Subnet as Ec2Subnet,
  type Vpc as Ec2Vpc,
  type VpcEndpoint as Ec2VpcEndpoint,
} from '@aws-sdk/client-ec2';
import { ECSClient, ListServicesCommand } from '@aws-sdk/client-ecs';
import {
  DescribeMountTargetsCommand,
  EFSClient,
  type MountTargetDescription,
} from '@aws-sdk/client-efs';
import {
  DescribeListenersCommand,
  DescribeRulesCommand,
  ElasticLoadBalancingV2Client,
  type Listener as Elbv2Listener,
  type Rule as Elbv2Rule,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  EventBridgeClient,
  ListRulesCommand,
  type Rule as EventBridgeRule,
} from '@aws-sdk/client-eventbridge';
import { type AliasListEntry, KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import {
  type AliasConfiguration as LambdaAliasConfiguration,
  type EventSourceMappingConfiguration,
  type FunctionConfiguration as LambdaVersionConfiguration,
  type FunctionUrlConfig,
  LambdaClient,
  ListAliasesCommand as ListLambdaAliasesCommand,
  ListEventSourceMappingsCommand,
  ListFunctionUrlConfigsCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  type DBInstance as RdsDBInstance,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  ListResourceRecordSetsCommand,
  type ResourceRecordSet,
  Route53Client,
} from '@aws-sdk/client-route-53';
import {
  ListSubscriptionsByTopicCommand,
  SNSClient,
  type Subscription as SnsSubscription,
} from '@aws-sdk/client-sns';
import { READ_RETRY } from './client-config.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import type { Desired } from '../desired/template-adapter.js';
import type { DesiredResource } from '../types.js';

// Fail-safe parent-ref match. A child enumerator links a DECLARED child to its enumerated
// parent by comparing the child's parent-ref property (UserPoolId, TopicArn, FunctionName,
// EventBusName, …) against the parent's physical id / ARN. When the intrinsic resolver could
// NOT evaluate that declared property it is the UNRESOLVED symbol — a `{{resolve:...}}`
// dynamic reference, a `Ref` to a no-default Parameter (#744), a degraded Fn::ImportValue
// (#784), a non-string Fn::Sub, or a malformed Fn::Join that fails closed (#851). A bare
// `===` then FAILS, so the declared child is dropped from the declared set and its LIVE
// counterpart is falsely flagged `[Added] created out of band` — offering a DESTRUCTIVE
// Cloud Control DeleteResource against a resource the template explicitly declares (#962).
// Fail SAFE: "we couldn't resolve what the template says" must never become "this live
// resource is out of band, delete it?", so an UNRESOLVED parent-ref counts as a POTENTIAL
// match and the declared child is KEPT. Otherwise the declared value must equal one of the
// candidate parent ids/ARNs (undefined candidates — e.g. an unresolved parent ARN — are
// ignored). Mirrors classify.ts's `v === UNRESOLVED || hasUnresolved(v)` detection.
function parentRefMatches(declaredValue: unknown, ...candidates: (string | undefined)[]): boolean {
  if (declaredValue === UNRESOLVED || hasUnresolved(declaredValue)) return true;
  return candidates.some((c) => c !== undefined && declaredValue === c);
}

// Drop a trailing `:qualifier` (an alias name, a numeric version, or `$LATEST`) from a
// Lambda function reference — the bare name / unqualified ARN / short `name:qualifier`
// form — returning the UNQUALIFIED function identity used for matching. An ESM bound to
// an alias/version (`alias.addEventSource(...)`) declares its `FunctionName` as the
// QUALIFIED ref (`fn:prod`, `arn:…:function:fn:prod`, `fn:1`, `fn:$LATEST`); its live
// mapping reads back the same qualified ARN, so it matches NEITHER the bare function name
// NOR the bare function ARN and the DECLARED alias-bound ESM is falsely flagged `added`
// (#803). Only a qualifier that FOLLOWS the function name is stripped: the `function:`
// ARN segment itself is preserved (`arn:…:function:fn` → unchanged), and a bare name / a
// full unqualified ARN passes through untouched.
export function unqualifiedFunctionRef(ref: unknown): unknown {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('arn:')) {
    // arn:partition:service:region:account:function:NAME[:QUALIFIER] — the resource id
    // is segments 6..; a QUALIFIER present makes it segments 6 (NAME) + 7 (QUALIFIER).
    const seg = ref.split(':');
    if (seg.length >= 8 && seg[5] === 'function') return seg.slice(0, 7).join(':');
    return ref;
  }
  // Partial ARN `<accountId>:function:NAME[:QUALIFIER]` — a documented FunctionName form that
  // is NOT prefixed `arn:`, so without this it falls into the short-form truncation below and
  // collapses to the account id (`123456789012`), matching neither the parent's bare name nor
  // its full ARN → the declared child is dropped and falsely flagged `added` (#1281). The bare
  // function name is the segment after `function:`.
  const partial = ref.match(/^\d{12}:function:([^:]+)/);
  if (partial) return partial[1];
  // Short forms: `NAME:QUALIFIER` (single colon) → `NAME`. A bare `NAME` has no colon.
  const i = ref.indexOf(':');
  return i === -1 ? ref : ref.slice(0, i);
}

// `parentRefMatches`, but comparing on the UNQUALIFIED function identity of BOTH sides —
// an alias/version-bound child's qualified `FunctionName` matches its unqualified parent
// function (#803). Out-of-band detection is preserved: only the identity used for the
// parent membership test is normalized; the per-child match downstream stays on the
// UUID / versioned-ARN.
function lambdaFunctionRefMatches(
  declaredValue: unknown,
  ...candidates: (string | undefined)[]
): boolean {
  const declaredUnqualified = unqualifiedFunctionRef(declaredValue);
  return parentRefMatches(
    declaredUnqualified,
    ...candidates.map((c) => (c === undefined ? undefined : (unqualifiedFunctionRef(c) as string)))
  );
}

// One out-of-band child resource: present live, absent from the template.
export interface AddedChild {
  resourceType: string; // CC TypeName of the child (e.g. AWS::ApiGateway::Method)
  identifier: string; // CC primaryIdentifier — feeds GetResource / DeleteResource (revert)
  label: string; // human display (e.g. 'ANY /', '/widgets')
  live: Record<string, unknown>; // live model snippet, for the report `actual`
  // The CloudFormation PHYSICAL-ID form used ONLY by the sibling-stack membership check
  // (DescribeStackResources). It usually EQUALS `identifier` (the CC primaryIdentifier IS
  // the CFn physical id for the cross-stack class), so it is optional and defaults to
  // `identifier`. It diverges when CC's identifier is NOT the CFn physical id — e.g.
  // AWS::Events::Rule: CC uses the bare rule Arn, but CFn stores `<busName>|<ruleName>`
  // for a custom-bus rule (bare `<ruleName>` on the default bus), so the ARN lookup always
  // misses and a sibling-managed rule is falsely reported `added` (#895). Only the sibling
  // lookup id changes; the CC read / DeleteResource path still uses `identifier`.
  siblingLookupId?: string | undefined;
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
// Functions (event source mappings) the fourth; EventBridge event buses (rules) the fifth;
// Cognito User Pools (clients) the sixth; AppSync GraphQL APIs (data sources) the seventh;
// CloudWatch Logs log groups (metric filters) the eighth; Elastic Load Balancing v2 load
// balancers (listeners) the ninth; EC2 VPCs (subnets) the tenth; EC2 route tables
// (routes) the eleventh; ECS clusters (services) the twelfth; KMS keys (aliases) the
// thirteenth; AppConfig applications (environments) the fourteenth; Elastic Load Balancing
// v2 listeners (rules) the fifteenth; EFS file systems (mount targets) the sixteenth;
// RDS DB clusters (DB instances) the seventeenth; Route53 hosted zones (record sets) the
// eighteenth; EC2 network ACLs (NACL entries) the nineteenth.
export const CHILD_ENUMERATORS: Record<string, ChildEnumerator> = {
  'AWS::ApiGateway::RestApi': enumerateRestApiChildren,
  'AWS::ApiGatewayV2::Api': enumerateHttpApiChildren,
  'AWS::SNS::Topic': enumerateSnsTopicChildren,
  'AWS::Lambda::Function': enumerateLambdaFunctionChildren,
  'AWS::Events::EventBus': enumerateEventBusChildren,
  'AWS::Cognito::UserPool': enumerateUserPoolChildren,
  'AWS::AppSync::GraphQLApi': enumerateGraphQLApiChildren,
  'AWS::Logs::LogGroup': enumerateLogGroupChildren,
  'AWS::ElasticLoadBalancingV2::LoadBalancer': enumerateLoadBalancerChildren,
  'AWS::ElasticLoadBalancingV2::Listener': enumerateListenerChildren,
  'AWS::EC2::VPC': enumerateVpcChildren,
  'AWS::EC2::RouteTable': enumerateRouteTableChildren,
  'AWS::EC2::NetworkAcl': enumerateNetworkAclChildren,
  'AWS::ECS::Cluster': enumerateEcsClusterChildren,
  'AWS::KMS::Key': enumerateKmsKeyChildren,
  'AWS::AppConfig::Application': enumerateAppConfigApplicationChildren,
  'AWS::EFS::FileSystem': enumerateEfsFileSystemChildren,
  'AWS::RDS::DBCluster': enumerateRdsClusterChildren,
  'AWS::Route53::HostedZone': enumerateRoute53HostedZoneChildren,
};

// ── API Gateway ────────────────────────────────────────────────────────────
// A RestApi owns Resources (paths), Methods, Authorizers, Models, and
// RequestValidators. Each is a separate
// CloudFormation resource, so the template lists every declared one; anything live
// but undeclared is an out-of-band addition. The root resource `/` is implicit
// (created with the RestApi) and so always counts as declared. A console / CLI
// `create-authorizer` (someone wires a new TOKEN / REQUEST / COGNITO_USER_POOLS
// authorizer onto the api out of band — a security-relevant change) is invisible to
// cdk drift / CFn drift detection. The RestApi's own live model does NOT reflect its
// authorizers inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::ApiGateway::Authorizer is the composite
// `["/properties/RestApiId","/properties/AuthorizerId"]`, so the `identifier` is the
// composite `RestApiId|AuthorizerId` (RestApiId first) — that is what CC
// GetResource / DeleteResource consume.

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
  // The RestApi declares a `Body` / `BodyS3Location` (OpenAPI / SpecRestApi) — its paths,
  // methods, and integrations are materialized by CloudFormation FROM that spec, not from
  // sibling AWS::ApiGateway::Resource / Method template resources. There is therefore no
  // per-child template declaration to diff against, so every Body-materialized resource /
  // method would otherwise flag as an out-of-band `added` on a clean deploy (issue #714).
  // When set, resource/method diffing is skipped entirely (returns []).
  bodyDefined?: boolean | undefined;
}

// A Body-defined (OpenAPI / SpecRestApi) RestApi declares its paths/methods inline via the
// `Body` (or `BodyS3Location`) property instead of as separate AWS::ApiGateway::Resource /
// Method template resources. Detect it from the declared Properties so child enumeration can
// be suppressed for it (issue #714).
export function isBodyDefinedRestApi(declared: Record<string, unknown>): boolean {
  return declared.Body != null || declared.BodyS3Location != null;
}

export function diffApiGatewayChildren(input: ApiGatewayChildInput): AddedChild[] {
  const {
    apiId,
    rootResourceId,
    declaredResourceIds,
    declaredMethodKeys,
    liveResources,
    liveMethodsByResource,
    bodyDefined,
  } = input;
  // Body-defined (OpenAPI / SpecRestApi) RestApi: paths/methods come from the `Body`, not
  // from sibling template resources, so there is nothing to diff them against. Suppress the
  // `added` classification for every Body-materialized resource/method (issue #714).
  if (bodyDefined) return [];
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

export async function enumerateRestApiChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const apiId = parent.physicalId;
  if (!apiId) return [];

  // RootResourceId is a readOnly attr already returned by the RestApi's CC read
  // (gather populated liveAttrs in pass 1); used to mark the `/` resource implicitly
  // declared even though GetResources also returns it.
  const restApiLive = desired.ctx.liveAttrs[parent.logicalId] ?? {};
  const rootResourceId =
    typeof restApiLive.RootResourceId === 'string' ? restApiLive.RootResourceId : undefined;

  // Body-defined (OpenAPI / SpecRestApi) RestApi: CloudFormation materializes its
  // resources/methods AND its Authorizers / Models / RequestValidators / GatewayResponses FROM
  // the declared `Body` / `BodyS3Location`, with no sibling AWS::ApiGateway::* template resources
  // to diff against. Skip enumerating (and flagging) them all as `added` — otherwise every
  // Body-materialized child is a first-run false positive on a clean deploy (Resources/Methods =
  // #714; Authorizers/Models/RequestValidators/GatewayResponses = #1324, the v1 twin of #960).
  // Stages are NOT spec-materialized (a REST Body import creates no stages), so stage diffing
  // stays fully on below (#1044).
  const bodyDefined = isBodyDefinedRestApi(parent.declared);

  // Declared children of THIS api (Ref/GetAtt already resolved to physical ids by gather).
  const declaredResourceIds: string[] = [];
  const declaredMethodKeys: string[] = [];
  for (const r of desired.resources) {
    if (!parentRefMatches(r.declared.RestApiId, apiId)) continue;
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

  // Declared authorizers of THIS api. An Authorizer's CFn physical id (Ref) IS its
  // AuthorizerId, and its declared RestApiId resolves (via gather) to the physical id.
  const declaredAuthorizerIds: string[] = [];
  // Declared models of THIS api. A Model's CFn physical id (Ref) IS its Name.
  const declaredModelNames: string[] = [];
  // Declared request validators of THIS api. A RequestValidator's CFn physical id (Ref)
  // IS its RequestValidatorId.
  const declaredValidatorIds: string[] = [];
  // Declared gateway responses of THIS api, matched by ResponseType.
  const declaredResponseTypes: string[] = [];
  // Fail-safe: a declared GatewayResponse whose IDENTITY (ResponseType) is UNRESOLVED can't be
  // matched against the live responses — suppress gateway-response added-reporting for this api
  // rather than false-flag a live DEFAULT_4XX/5XX as `added` with a DeleteResource offer (#1089).
  let gatewayResponseTypeUnresolved = false;
  // Declared stages of THIS api. An AWS::ApiGateway::Stage's Ref/physical id IS its StageName.
  const declaredStageNames: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::ApiGateway::Authorizer' &&
      parentRefMatches(r.declared.RestApiId, apiId) &&
      r.physicalId
    ) {
      declaredAuthorizerIds.push(r.physicalId);
    } else if (
      r.resourceType === 'AWS::ApiGateway::Model' &&
      parentRefMatches(r.declared.RestApiId, apiId)
    ) {
      const name = typeof r.declared.Name === 'string' ? r.declared.Name : r.physicalId;
      if (name) declaredModelNames.push(name);
    } else if (
      r.resourceType === 'AWS::ApiGateway::RequestValidator' &&
      parentRefMatches(r.declared.RestApiId, apiId) &&
      r.physicalId
    ) {
      declaredValidatorIds.push(r.physicalId);
    } else if (
      r.resourceType === 'AWS::ApiGateway::GatewayResponse' &&
      parentRefMatches(r.declared.RestApiId, apiId)
    ) {
      if (r.declared.ResponseType === UNRESOLVED || hasUnresolved(r.declared.ResponseType)) {
        gatewayResponseTypeUnresolved = true;
      } else if (typeof r.declared.ResponseType === 'string') {
        declaredResponseTypes.push(r.declared.ResponseType);
      }
    } else if (
      r.resourceType === 'AWS::ApiGateway::Stage' &&
      parentRefMatches(r.declared.RestApiId, apiId)
    ) {
      const name = typeof r.declared.StageName === 'string' ? r.declared.StageName : r.physicalId;
      if (name) declaredStageNames.push(name);
    }
  }

  const client = new APIGatewayClient({ region, ...READ_RETRY });
  // Skip the GetResources sweep entirely for a Body-defined api — every live resource/method
  // it returns is spec-materialized (not template-declared), so diffing would be pure noise.
  const items = bodyDefined ? [] : await getAllResources(client, apiId);
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

  const resourceAndMethodAdded = diffApiGatewayChildren({
    apiId,
    rootResourceId,
    declaredResourceIds,
    declaredMethodKeys,
    liveResources,
    liveMethodsByResource,
    bodyDefined,
  });

  // Body-defined (OpenAPI / SpecRestApi) RestApi: its Authorizers / Models / RequestValidators /
  // GatewayResponses are all materialized by CloudFormation FROM the spec (components.securitySchemes
  // + x-amazon-apigateway-authorizer → Authorizers; components.schemas / definitions → Models;
  // x-amazon-apigateway-request-validators → RequestValidators; x-amazon-apigateway-gateway-responses
  // → GatewayResponses), with no sibling template resources to diff against. Skip enumerating (and
  // flagging) them — otherwise every spec-materialized child is a first-run false positive on a clean
  // deploy, each offering a DeleteResource that would strip the spec's auth / schemas (issue #1324,
  // the v1 twin of #714's Resource/Method gate and #960's V2 gate). The `bodyDefined` flag is also
  // threaded into each diff below as a fail-safe short-circuit.
  const authorizers = bodyDefined ? [] : await getAllAuthorizers(client, apiId);
  const liveAuthorizers = authorizers
    .filter((a): a is ApiGwAuthorizer & { id: string } => typeof a.id === 'string')
    .map((a) => ({ id: a.id, label: a.name ?? a.id }));
  const authorizerAdded = diffApiGatewayAuthorizers({
    apiId,
    declaredAuthorizerIds,
    liveAuthorizers,
    bodyDefined,
  });

  const models = bodyDefined ? [] : await getAllModels(client, apiId);
  const liveModels = models
    .filter((m): m is ApiGwModel & { name: string } => typeof m.name === 'string')
    .map((m) => ({ name: m.name, label: m.name }));
  const modelAdded = diffApiGatewayModels({ apiId, declaredModelNames, liveModels, bodyDefined });

  const validators = bodyDefined ? [] : await getAllRequestValidators(client, apiId);
  const liveValidators = validators
    .filter((v): v is ApiGwRequestValidator & { id: string } => typeof v.id === 'string')
    .map((v) => ({ id: v.id, label: v.name ?? v.id }));
  const validatorAdded = diffApiGatewayRequestValidators({
    apiId,
    declaredValidatorIds,
    liveValidators,
    bodyDefined,
  });

  const gatewayResponses = bodyDefined ? [] : await getAllGatewayResponses(client, apiId);
  const liveResponseTypes = gatewayResponses
    .filter(
      (g): g is ApiGwGatewayResponse & { responseType: string } =>
        typeof g.responseType === 'string'
    )
    .map((g) => ({ type: g.responseType, label: g.responseType }));
  const gatewayResponseAdded = diffApiGatewayGatewayResponses({
    apiId,
    declaredResponseTypes,
    liveResponseTypes,
    hasUnresolvedDeclaredResponseType: gatewayResponseTypeUnresolved,
    bodyDefined,
  });

  // Stages — the V2 enumerator (enumerateHttpApiChildren) already sweeps + diffs Stages; the
  // V1 enumerator never did, so an out-of-band create-stage (a new public endpoint, or one
  // with access logging / throttling off) read CLEAN and survived record (#1044). FP-safe:
  // AWS does not auto-create REST stages, so no built-in filter is needed (unlike the V2
  // quick-create `$default` stage, #960) — a live stage not matching a declared
  // AWS::ApiGateway::Stage is genuinely out of band.
  const stages = await getAllStages(client, apiId);
  const liveStages = stages
    .filter((s): s is ApiGwRestStage & { stageName: string } => typeof s.stageName === 'string')
    .map((s) => ({ name: s.stageName, label: s.stageName }));
  const stageAdded = diffApiGatewayStages({ apiId, declaredStageNames, liveStages });

  return [
    ...resourceAndMethodAdded,
    ...authorizerAdded,
    ...modelAdded,
    ...validatorAdded,
    ...gatewayResponseAdded,
    ...stageAdded,
  ];
}

// Pure diff: declared stage names + live inventory -> the added (out-of-band) stages. A live
// stage whose name matches no declared AWS::ApiGateway::Stage is out of band. Identifier is
// the CC composite `RestApiId|StageName` (verified via describe-type), so the `added` finding
// and its CC DeleteResource revert work cleanly. Separated from the SDK call for offline tests.
export function diffApiGatewayStages(input: {
  apiId: string;
  declaredStageNames: string[];
  liveStages: { name: string; label?: string | undefined }[];
}): AddedChild[] {
  const { apiId, declaredStageNames, liveStages } = input;
  const declared = new Set(declaredStageNames);
  const added: AddedChild[] = [];
  for (const s of liveStages) {
    if (declared.has(s.name)) continue;
    added.push({
      resourceType: 'AWS::ApiGateway::Stage',
      identifier: `${apiId}|${s.name}`, // CC composite RestApiId|StageName
      label: s.label ?? s.name,
      live: { StageName: s.name, RestApiId: apiId },
    });
  }
  return added;
}

// v1 GetStages returns ALL of a REST API's stages in one call (not paginated — a REST API
// has only a handful of stages).
async function getAllStages(client: APIGatewayClient, apiId: string): Promise<ApiGwRestStage[]> {
  const res = await client.send(new GetRestStagesCommand({ restApiId: apiId }));
  return res.item ?? [];
}

// Pure diff: declared authorizer ids + live inventory -> the added authorizers.
// Separated from the SDK calls so the matching logic is unit-tested offline.
export interface ApiGatewayAuthorizerInput {
  apiId: string;
  declaredAuthorizerIds: string[]; // physical ids (AuthorizerIds) of AWS::ApiGateway::Authorizer
  liveAuthorizers: { id: string; label?: string | undefined }[];
  // The RestApi is Body-defined (OpenAPI / SpecRestApi): CloudFormation materializes its
  // authorizers from the spec's `components.securitySchemes` + `x-amazon-apigateway-authorizer`
  // entries, not from sibling AWS::ApiGateway::Authorizer template resources. There is therefore
  // no per-child template declaration to diff against, so every spec-materialized authorizer
  // would otherwise flag as an out-of-band `added` on a clean deploy — each offering a
  // DeleteResource that would disable the API's auth. When set, authorizer diffing is skipped
  // entirely (returns []) — the v1 twin of #960's `diffApiGatewayV2Authorizers` gate (issue #1324).
  bodyDefined?: boolean | undefined;
}

export function diffApiGatewayAuthorizers(input: ApiGatewayAuthorizerInput): AddedChild[] {
  const { apiId, declaredAuthorizerIds, liveAuthorizers, bodyDefined } = input;
  // Body-defined (OpenAPI / SpecRestApi) RestApi: authorizers come from the spec, not from
  // sibling template resources, so there is nothing to diff them against (issue #1324).
  if (bodyDefined) return [];
  const declared = new Set(declaredAuthorizerIds);
  const added: AddedChild[] = [];
  for (const a of liveAuthorizers) {
    if (declared.has(a.id)) continue;
    added.push({
      resourceType: 'AWS::ApiGateway::Authorizer',
      identifier: `${apiId}|${a.id}`, // CC composite RestApiId|AuthorizerId
      label: a.label ?? a.id,
      live: { AuthorizerId: a.id, RestApiId: apiId },
    });
  }
  return added;
}

// Page GetAuthorizers (position-paginated like GetResources).
async function getAllAuthorizers(
  client: APIGatewayClient,
  apiId: string
): Promise<ApiGwAuthorizer[]> {
  const out: ApiGwAuthorizer[] = [];
  let position: string | undefined;
  do {
    const res = await client.send(
      new GetAuthorizersCommand({ restApiId: apiId, limit: 500, position })
    );
    out.push(...(res.items ?? []));
    position = res.position;
  } while (position);
  return out;
}

// A RestApi also owns Models (request/response body schemas) and RequestValidators
// (per-method body/parameter validation rules), each a separate CloudFormation resource.
// A console / CLI `create-model` / `create-request-validator` (someone wires a new model
// or validator onto an api out of band) is invisible to cdk drift / CFn drift detection.
// The RestApi's own live model does NOT reflect its models or validators inline, so there
// is no double-report to suppress. The CC primaryIdentifier for AWS::ApiGateway::Model is
// the composite `["/properties/RestApiId","/properties/Name"]` (identifier `RestApiId|Name`)
// and for AWS::ApiGateway::RequestValidator the composite
// `["/properties/RestApiId","/properties/RequestValidatorId"]` (identifier
// `RestApiId|RequestValidatorId`) — that is what CC GetResource / DeleteResource consume.
// NOTE: every RestApi ships two built-in default models (`Empty`, `Error`) auto-created
// by AWS with the api; they appear live on EVERY RestApi but are never template
// resources, so a clean no-change deploy would otherwise surface them as `added` on
// every run. Like the implicit root `/` resource, the GatewayResponse defaults
// (`defaultResponse: true`), and the ELBv2 listener default rule (`IsDefault`), they
// are AWS-generated built-ins and are filtered out below rather than left for `record`.
const BUILTIN_MODEL_NAMES = new Set(['Empty', 'Error']);

// Pure diff: declared model names + live inventory -> the added models. A Model's CFn
// physical id (Ref) IS its Name, so declared models are matched by Name.
export interface ApiGatewayModelInput {
  apiId: string;
  declaredModelNames: string[]; // Names of AWS::ApiGateway::Model declared on this api
  liveModels: { name: string; label?: string | undefined }[];
  // The RestApi is Body-defined (OpenAPI / SpecRestApi): CloudFormation materializes its models
  // from the spec's `components.schemas` / `definitions`, not from sibling AWS::ApiGateway::Model
  // template resources. There is therefore no per-child template declaration to diff against, so
  // every spec-materialized model would otherwise flag as an out-of-band `added` on a clean deploy.
  // When set, model diffing is skipped entirely (returns []) — the v1 twin of #960 (issue #1324).
  bodyDefined?: boolean | undefined;
}

export function diffApiGatewayModels(input: ApiGatewayModelInput): AddedChild[] {
  const { apiId, declaredModelNames, liveModels, bodyDefined } = input;
  // Body-defined (OpenAPI / SpecRestApi) RestApi: models come from the spec, not from sibling
  // template resources, so there is nothing to diff them against (issue #1324).
  if (bodyDefined) return [];
  const declared = new Set(declaredModelNames);
  const added: AddedChild[] = [];
  for (const m of liveModels) {
    if (declared.has(m.name)) continue;
    // AWS auto-creates `Empty`/`Error` on every RestApi — never an out-of-band add.
    // (A user who explicitly declares one is matched by the `declared` check above.)
    if (BUILTIN_MODEL_NAMES.has(m.name)) continue;
    added.push({
      resourceType: 'AWS::ApiGateway::Model',
      identifier: `${apiId}|${m.name}`, // CC composite RestApiId|Name
      label: m.label ?? m.name,
      live: { Name: m.name, RestApiId: apiId },
    });
  }
  return added;
}

// Page GetModels (position-paginated like GetResources / GetAuthorizers).
async function getAllModels(client: APIGatewayClient, apiId: string): Promise<ApiGwModel[]> {
  const out: ApiGwModel[] = [];
  let position: string | undefined;
  do {
    const res = await client.send(new GetModelsCommand({ restApiId: apiId, limit: 500, position }));
    out.push(...(res.items ?? []));
    position = res.position;
  } while (position);
  return out;
}

// Pure diff: declared validator ids + live inventory -> the added request validators. A
// RequestValidator's CFn physical id (Ref) IS its RequestValidatorId, so declared
// validators are matched by RequestValidatorId.
export interface ApiGatewayRequestValidatorInput {
  apiId: string;
  declaredValidatorIds: string[]; // physical ids (RequestValidatorIds) of AWS::ApiGateway::RequestValidator
  liveValidators: { id: string; label?: string | undefined }[];
  // The RestApi is Body-defined (OpenAPI / SpecRestApi): CloudFormation materializes its request
  // validators from the spec's `x-amazon-apigateway-request-validators`, not from sibling
  // AWS::ApiGateway::RequestValidator template resources. There is therefore no per-child template
  // declaration to diff against, so every spec-materialized validator would otherwise flag as an
  // out-of-band `added` on a clean deploy. When set, validator diffing is skipped entirely
  // (returns []) — the v1 twin of #960 (issue #1324).
  bodyDefined?: boolean | undefined;
}

export function diffApiGatewayRequestValidators(
  input: ApiGatewayRequestValidatorInput
): AddedChild[] {
  const { apiId, declaredValidatorIds, liveValidators, bodyDefined } = input;
  // Body-defined (OpenAPI / SpecRestApi) RestApi: request validators come from the spec, not from
  // sibling template resources, so there is nothing to diff them against (issue #1324).
  if (bodyDefined) return [];
  const declared = new Set(declaredValidatorIds);
  const added: AddedChild[] = [];
  for (const v of liveValidators) {
    if (declared.has(v.id)) continue;
    added.push({
      resourceType: 'AWS::ApiGateway::RequestValidator',
      identifier: `${apiId}|${v.id}`, // CC composite RestApiId|RequestValidatorId
      label: v.label ?? v.id,
      live: { RequestValidatorId: v.id, RestApiId: apiId },
    });
  }
  return added;
}

// Page GetRequestValidators (position-paginated like GetModels / GetAuthorizers).
async function getAllRequestValidators(
  client: APIGatewayClient,
  apiId: string
): Promise<ApiGwRequestValidator[]> {
  const out: ApiGwRequestValidator[] = [];
  let position: string | undefined;
  do {
    const res = await client.send(
      new GetRequestValidatorsCommand({ restApiId: apiId, limit: 500, position })
    );
    out.push(...(res.items ?? []));
    position = res.position;
  } while (position);
  return out;
}

// A RestApi also owns GatewayResponses (per-response-type error customizations, e.g.
// DEFAULT_4XX, UNAUTHORIZED), each a separate CloudFormation resource. A console / CLI
// `put-gateway-response` (someone customizes a gateway response on an api out of band) is
// invisible to cdk drift / CFn drift detection. The RestApi's own live model does NOT
// reflect its gateway responses inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::ApiGateway::GatewayResponse is the SINGLE `["/properties/Id"]`,
// whose runtime form is `${RestApiId}:${ResponseType}` (COLON-joined — verified live via CC
// GetResource/ListResources; a `|`-joined composite is rejected as "not valid for identifier
// [/properties/Id]"). So the `identifier` is `RestApiId:ResponseType` — that is what CC
// GetResource / DeleteResource consume. NOTE: GetGatewayResponses returns ALL ~17 supported response
// types, most as API Gateway-generated DEFAULTS (`defaultResponse: true`) that are NOT real
// AWS::ApiGateway::GatewayResponse resources; the enumerator filters to the CUSTOMIZED ones
// (`defaultResponse === false`) before diffing, so the un-customized defaults never flag.

// Pure diff: declared response types + live (already filtered to customized) inventory ->
// the added gateway responses. A GatewayResponse is matched by ResponseType.
export interface ApiGatewayGatewayResponseInput {
  apiId: string;
  declaredResponseTypes: string[]; // ResponseTypes of AWS::ApiGateway::GatewayResponse on this api
  liveResponseTypes: { type: string; label?: string | undefined }[];
  // Fail-safe (#1089): a declared GatewayResponse's identity (ResponseType) was UNRESOLVED, so it
  // could not be matched against the live responses — suppress ALL added for this api.
  hasUnresolvedDeclaredResponseType?: boolean;
  // The RestApi is Body-defined (OpenAPI / SpecRestApi): CloudFormation materializes its gateway
  // responses from the spec's `x-amazon-apigateway-gateway-responses`, not from sibling
  // AWS::ApiGateway::GatewayResponse template resources. There is therefore no per-child template
  // declaration to diff against, so every spec-materialized gateway response would otherwise flag
  // as an out-of-band `added` on a clean deploy. When set, gateway-response diffing is skipped
  // entirely (returns []) — the v1 twin of #960 (issue #1324).
  bodyDefined?: boolean | undefined;
}

export function diffApiGatewayGatewayResponses(
  input: ApiGatewayGatewayResponseInput
): AddedChild[] {
  // Body-defined (OpenAPI / SpecRestApi) RestApi: gateway responses come from the spec, not from
  // sibling template resources, so there is nothing to diff them against (issue #1324).
  if (input.bodyDefined) return [];
  if (input.hasUnresolvedDeclaredResponseType) return [];
  const { apiId, declaredResponseTypes, liveResponseTypes } = input;
  const declared = new Set(declaredResponseTypes);
  const added: AddedChild[] = [];
  for (const r of liveResponseTypes) {
    if (declared.has(r.type)) continue;
    added.push({
      resourceType: 'AWS::ApiGateway::GatewayResponse',
      identifier: `${apiId}:${r.type}`, // CC single Id `RestApiId:ResponseType` (colon-joined)
      label: r.label ?? r.type,
      live: { ResponseType: r.type, RestApiId: apiId },
    });
  }
  return added;
}

// Page GetGatewayResponses (position-paginated for parity; the collection does not paginate).
// Returns ONLY customized responses (`defaultResponse === false`) — the API
// Gateway-generated defaults (`defaultResponse: true`) are not real resources.
async function getAllGatewayResponses(
  client: APIGatewayClient,
  apiId: string
): Promise<ApiGwGatewayResponse[]> {
  const out: ApiGwGatewayResponse[] = [];
  let position: string | undefined;
  do {
    const res = await client.send(
      new GetGatewayResponsesCommand({ restApiId: apiId, limit: 500, position })
    );
    for (const g of res.items ?? []) {
      if (g.defaultResponse === false && typeof g.responseType === 'string') out.push(g);
    }
    position = res.position;
  } while (position);
  return out;
}

// ── API Gateway V2 (HTTP / WebSocket) ────────────────────────────────────────
// An `AWS::ApiGatewayV2::Api` owns Routes, Integrations, Authorizers, and Stages, each a
// SEPARATE CloudFormation resource — the direct V2 analogue of REST's Resources +
// Methods + Stages. A console-added Route (e.g. `GET /admin`), Integration, Authorizer,
// or Stage is invisible to `cdk drift` / CFn drift detection (they only compare
// template-declared resources). Unlike REST there is no implicit "root" child to
// special-case, and these children are siblings (not nested), so each is reported
// independently. Both protocol types (HTTP and WebSocket) use the same Api type +
// GetRoutes/GetIntegrations/GetAuthorizers/GetStages APIs, so one enumerator covers both.
// The Api model does NOT reflect its authorizers/stages inline, so there is no
// double-report to suppress. CC `GetResource`/`DeleteResource` consume the composite
// identifier (`ApiId|RouteId` / `ApiId|IntegrationId` / `AuthorizerId|ApiId` /
// `ApiId|StageName`), so revert deletes generically.

// An AWS::ApiGatewayV2::Api (HTTP API) has the same two template-inline definition modes
// as a REST api (issue #714 / #960):
//   1. Body-defined (OpenAPI import): a `Body` / `BodyS3Location` property — CloudFormation
//      materializes every Route, Integration, and Authorizer (x-amazon-apigateway-authorizer)
//      FROM the spec, with no sibling AWS::ApiGatewayV2::Route / Integration / Authorizer
//      template resources to diff against. Stages are NOT spec-materialized in Body mode.
//   2. Quick create: a `Target` (+ optional RouteKey / CredentialsArn) — the service produces
//      an API with an integration, a default catch-all route, and a `$default` stage
//      configured to auto-deploy, none of which is a separate template resource.
// In either mode the spec-/quick-create-materialized children have no per-child template
// declaration, so every live one would otherwise flag as an out-of-band `added` on a clean
// deploy. Detect the mode from the declared Properties so child enumeration can be suppressed.
export function isBodyDefinedHttpApi(declared: Record<string, unknown>): boolean {
  return declared.Body != null || declared.BodyS3Location != null;
}

export function isQuickCreateHttpApi(declared: Record<string, unknown>): boolean {
  return declared.Target != null;
}

// Pure diff: declared child id sets + live inventory -> the added children. Separated
// from the SDK calls so the matching is unit-tested offline (mirrors REST).
export interface ApiGatewayV2ChildInput {
  apiId: string;
  declaredRouteIds: string[]; // physical ids of AWS::ApiGatewayV2::Route in the template
  declaredIntegrationIds: string[]; // physical ids of AWS::ApiGatewayV2::Integration
  liveRoutes: { id: string; key?: string | undefined }[];
  liveIntegrations: { id: string; label?: string | undefined }[];
  // The Api is Body-defined (OpenAPI) OR quick-create (Target): its Routes / Integrations are
  // materialized by the service FROM the declared spec / target, not from sibling template
  // resources, so there is nothing to diff them against. When set, route/integration diffing is
  // skipped entirely (returns []) — otherwise every materialized route/integration is a
  // first-run false positive on a clean deploy (issue #960, the V2 twin of #714).
  specMaterialized?: boolean | undefined;
}

export function diffApiGatewayV2Children(input: ApiGatewayV2ChildInput): AddedChild[] {
  const {
    apiId,
    declaredRouteIds,
    declaredIntegrationIds,
    liveRoutes,
    liveIntegrations,
    specMaterialized,
  } = input;
  // Body-defined (OpenAPI) / quick-create (Target) Api: routes/integrations come from the spec /
  // target, not from sibling template resources, so there is nothing to diff them against.
  // Suppress the `added` classification for every materialized route/integration (issue #960).
  if (specMaterialized) return [];
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

// Pure diff: declared authorizer ids + live inventory -> the added authorizers. An
// AWS::ApiGatewayV2::Authorizer's CFn physical id (Ref) IS its AuthorizerId, so declared
// authorizers are matched by AuthorizerId. The CC primaryIdentifier is the composite
// `["/properties/AuthorizerId","/properties/ApiId"]` (AuthorizerId FIRST), so the
// `identifier` is `AuthorizerId|ApiId` — that is what CC GetResource / DeleteResource consume.
export function diffApiGatewayV2Authorizers(input: {
  apiId: string;
  declaredAuthorizerIds: string[]; // physical ids (AuthorizerIds) of AWS::ApiGatewayV2::Authorizer
  liveAuthorizers: { id: string; label?: string | undefined }[];
  // The Api is Body-defined (OpenAPI): CloudFormation materializes its authorizers from the
  // spec's `x-amazon-apigateway-authorizer` entries, not from sibling
  // AWS::ApiGatewayV2::Authorizer template resources. When set, authorizer diffing is skipped
  // entirely (issue #960). Quick create (Target) never materializes an authorizer, so this
  // covers the Body/BodyS3Location case only.
  bodyDefined?: boolean | undefined;
}): AddedChild[] {
  const { apiId, declaredAuthorizerIds, liveAuthorizers, bodyDefined } = input;
  // Body-defined (OpenAPI) Api: authorizers come from the spec, not from sibling template
  // resources, so there is nothing to diff them against (issue #960).
  if (bodyDefined) return [];
  const declared = new Set(declaredAuthorizerIds);
  const added: AddedChild[] = [];
  for (const a of liveAuthorizers) {
    if (declared.has(a.id)) continue;
    added.push({
      resourceType: 'AWS::ApiGatewayV2::Authorizer',
      identifier: `${a.id}|${apiId}`, // CC composite AuthorizerId|ApiId (AuthorizerId first)
      label: a.label ?? a.id,
      live: { AuthorizerId: a.id, ApiId: apiId },
    });
  }
  return added;
}

async function pageV2Authorizers(
  client: ApiGatewayV2Client,
  apiId: string
): Promise<ApiGwV2Authorizer[]> {
  const out: ApiGwV2Authorizer[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new GetV2AuthorizersCommand({ ApiId: apiId, NextToken: next }));
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

// Pure diff: declared stage names + live inventory -> the added stages. An
// AWS::ApiGatewayV2::Stage's CFn physical id (Ref) IS its StageName, so declared stages
// are matched by StageName. The CC primaryIdentifier is the composite
// `["/properties/ApiId","/properties/StageName"]`, so the `identifier` is
// `ApiId|StageName` — that is what CC GetResource / DeleteResource consume.
export function diffApiGatewayV2Stages(input: {
  apiId: string;
  declaredStageNames: string[]; // physical ids (StageNames) of AWS::ApiGatewayV2::Stage
  liveStages: { name: string; label?: string | undefined }[];
  // The Api is quick-create (Target): the service auto-creates a `$default` stage configured to
  // auto-deploy, with no sibling AWS::ApiGatewayV2::Stage template resource. Suppress only that
  // `$default` stage — a user can still declare EXTRA stages on a quick-create API, and those
  // stay diffable (issue #960). Body-defined APIs do NOT materialize stages from the spec, so
  // stage diffing stays fully on for them (this flag is set for quick create only).
  quickCreate?: boolean | undefined;
}): AddedChild[] {
  const { apiId, declaredStageNames, liveStages, quickCreate } = input;
  const declared = new Set(declaredStageNames);
  const added: AddedChild[] = [];
  for (const s of liveStages) {
    if (declared.has(s.name)) continue;
    // Quick create owns the auto-deployed `$default` stage; it is not an out-of-band addition.
    if (quickCreate && s.name === '$default') continue;
    added.push({
      resourceType: 'AWS::ApiGatewayV2::Stage',
      identifier: `${apiId}|${s.name}`, // CC composite ApiId|StageName
      label: s.label ?? s.name,
      live: { StageName: s.name, ApiId: apiId },
    });
  }
  return added;
}

async function pageV2Stages(client: ApiGatewayV2Client, apiId: string): Promise<ApiGwV2Stage[]> {
  const out: ApiGwV2Stage[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new GetStagesCommand({ ApiId: apiId, NextToken: next }));
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateHttpApiChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const apiId = parent.physicalId;
  if (!apiId) return [];

  // Body-defined (OpenAPI) or quick-create (Target) HTTP API: CloudFormation / the service
  // materializes its Routes / Integrations (both modes) and Authorizers (Body only) and the
  // `$default` Stage (quick create only) FROM the declared spec / target, with no sibling
  // AWS::ApiGatewayV2::Route / Integration / Authorizer / Stage template resources to diff
  // against. Suppress enumerating those materialized children as `added` — otherwise every one
  // is a first-run false positive on a clean deploy (issue #960, the V2 twin of #714).
  // Explicitly declared EXTRA stages (Body mode) / non-`$default` stages (quick create) still
  // enumerate below.
  const bodyDefined = isBodyDefinedHttpApi(parent.declared);
  const quickCreate = isQuickCreateHttpApi(parent.declared);
  const specMaterialized = bodyDefined || quickCreate;

  // Declared children of THIS api (Ref/GetAtt ApiId already resolved to the physical id
  // by gather). Route/Integration physical ids ARE the RouteId/IntegrationId.
  const declaredRouteIds: string[] = [];
  const declaredIntegrationIds: string[] = [];
  // Declared authorizers of THIS api. An Authorizer's physical id (Ref) IS its AuthorizerId.
  const declaredAuthorizerIds: string[] = [];
  // Declared stages of THIS api. A Stage's physical id (Ref) IS its StageName.
  const declaredStageNames: string[] = [];
  for (const r of desired.resources) {
    if (!parentRefMatches(r.declared.ApiId, apiId)) continue;
    if (r.resourceType === 'AWS::ApiGatewayV2::Route' && r.physicalId) {
      declaredRouteIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::ApiGatewayV2::Integration' && r.physicalId) {
      declaredIntegrationIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::ApiGatewayV2::Authorizer' && r.physicalId) {
      declaredAuthorizerIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::ApiGatewayV2::Stage') {
      const name = r.physicalId ?? (r.declared.StageName as string | undefined);
      if (name) declaredStageNames.push(name);
    }
  }

  const client = new ApiGatewayV2Client({ region, ...READ_RETRY });
  const [routes, integrations, authorizers, stages] = await Promise.all([
    pageRoutes(client, apiId),
    pageIntegrations(client, apiId),
    pageV2Authorizers(client, apiId),
    pageV2Stages(client, apiId),
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
  const liveAuthorizers = authorizers
    .filter(
      (a): a is ApiGwV2Authorizer & { AuthorizerId: string } => typeof a.AuthorizerId === 'string'
    )
    .map((a) => ({ id: a.AuthorizerId, label: a.Name ?? a.AuthorizerId }));
  const liveStages = stages
    .filter((s): s is ApiGwV2Stage & { StageName: string } => typeof s.StageName === 'string')
    .map((s) => ({ name: s.StageName }));

  const added = diffApiGatewayV2Children({
    apiId,
    declaredRouteIds,
    declaredIntegrationIds,
    liveRoutes,
    liveIntegrations,
    specMaterialized,
  });
  const authorizerAdded = diffApiGatewayV2Authorizers({
    apiId,
    declaredAuthorizerIds,
    liveAuthorizers,
    bodyDefined,
  });
  const stageAdded = diffApiGatewayV2Stages({
    apiId,
    declaredStageNames,
    liveStages,
    quickCreate,
  });
  return added.concat(authorizerAdded, stageAdded);
}

// ── SNS ──────────────────────────────────────────────────────────────────────
// An `AWS::SNS::Topic` owns Subscriptions, each a separate CloudFormation resource.
// A console-added subscription (someone wires an email / SQS / Lambda endpoint to a
// topic out of band) is invisible to `cdk drift` / CFn drift detection. The CC
// primaryIdentifier for AWS::SNS::Subscription is the bare SubscriptionArn (not a
// composite), which CC GetResource / DeleteResource consume.
//
// ONE implicit child must be special-cased: AWS Chatbot (the Slack / Teams / Chime
// channel configs behind `AWS::Chatbot::SlackChannelConfiguration`, and the Amazon Q
// Developer console) AUTO-subscribes its fixed global endpoint to every SNS topic a
// channel config points at — so a stack that declares a SlackChannelConfiguration +
// alarm topic always grows an `https` subscription to that endpoint that is NOT in the
// template. It is an AWS-managed side effect of the declared config, not a user's
// out-of-band change, so reporting it as an `added` resource is a false positive. The
// endpoint is a constant AWS-owned host; any subscription to it is Chatbot-managed, so
// folding it can never mask a genuine out-of-band subscription.
const CHATBOT_SUBSCRIPTION_ENDPOINT = 'https://global.sns-api.chatbot.amazonaws.com';

// Pure diff: declared subscription arns + live inventory -> the added subscriptions.
export interface SnsTopicChildInput {
  declaredSubscriptionArns: string[]; // physical ids of AWS::SNS::Subscription in the template
  liveSubscriptions: { arn: string; label?: string | undefined; endpoint?: string | undefined }[];
}

export function diffSnsTopicChildren(input: SnsTopicChildInput): AddedChild[] {
  const declared = new Set(input.declaredSubscriptionArns);
  const added: AddedChild[] = [];
  for (const s of input.liveSubscriptions) {
    if (declared.has(s.arn)) continue;
    if (s.endpoint === CHATBOT_SUBSCRIPTION_ENDPOINT) continue; // AWS Chatbot auto-managed
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

export async function enumerateSnsTopicChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const topicArn = parent.physicalId; // the Topic's physical id IS its ARN
  if (!topicArn) return [];

  // Declared subscriptions of THIS topic (Ref/GetAtt TopicArn already resolved by gather).
  // A subscription's physical id IS its SubscriptionArn.
  const declaredSubscriptionArns: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::SNS::Subscription' &&
      parentRefMatches(r.declared.TopicArn, topicArn) &&
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
      endpoint: s.Endpoint,
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
//
// A Function ALSO owns at most one Function URL per qualifier (AWS::Lambda::Url). A
// console / CLI `create-function-url-config` (someone exposes a public HTTPS endpoint
// out of band — a security-relevant change, especially `AuthType: NONE`) is invisible
// to cdk drift / CFn drift detection, and the Function's own live model does NOT reflect
// its URL inline, so there is no double-report to suppress. The CC primaryIdentifier for
// AWS::Lambda::Url is the bare FunctionArn of the URL config, which CC GetResource /
// DeleteResource consume.
//
// A Function ALSO owns Aliases (AWS::Lambda::Alias) — named pointers to a published
// version (e.g. `prod`, `live`). A console / CLI `create-alias` (someone wires a new
// alias to a function out of band) is invisible to cdk drift / CFn drift detection, and
// the Function's own live model does NOT reflect its aliases inline, so there is no
// double-report to suppress. The CC primaryIdentifier for AWS::Lambda::Alias is the bare
// AliasArn, which CC GetResource / DeleteResource consume.
//
// A Function ALSO owns published Versions (AWS::Lambda::Version) — immutable snapshots of
// the function's code + config. A console / CLI `publish-version` (someone publishes a new
// version out of band) is invisible to cdk drift / CFn drift detection, and the Function's
// own live model does NOT reflect its versions inline, so there is no double-report to
// suppress. The `$LATEST` pseudo-version is NOT a real AWS::Lambda::Version resource and is
// skipped. The CC primaryIdentifier for AWS::Lambda::Version is the bare versioned
// FunctionArn (e.g. `arn:...:function:fn:2`), which CC GetResource / DeleteResource consume.

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

// Pure diff: declared URL FunctionArns + live inventory -> the added function URLs.
export function diffLambdaFunctionUrls(input: {
  declaredUrlArns: string[];
  liveUrls: { arn: string; label?: string | undefined }[];
}): AddedChild[] {
  const declared = new Set(input.declaredUrlArns);
  const added: AddedChild[] = [];
  for (const u of input.liveUrls) {
    if (declared.has(u.arn)) continue;
    added.push({
      resourceType: 'AWS::Lambda::Url',
      identifier: u.arn, // the URL config's FunctionArn IS the CC primaryIdentifier
      label: u.label ?? u.arn,
      live: { FunctionArn: u.arn },
    });
  }
  return added;
}

async function pageFunctionUrlConfigs(
  client: LambdaClient,
  functionName: string
): Promise<FunctionUrlConfig[]> {
  const out: FunctionUrlConfig[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new ListFunctionUrlConfigsCommand({ FunctionName: functionName, Marker: marker })
    );
    out.push(...(res.FunctionUrlConfigs ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

// Pure diff: declared alias arns + live inventory -> the added aliases.
export function diffLambdaFunctionAliases(input: {
  declaredAliasArns: string[];
  liveAliases: { arn: string; label?: string | undefined }[];
}): AddedChild[] {
  const declared = new Set(input.declaredAliasArns);
  const added: AddedChild[] = [];
  for (const a of input.liveAliases) {
    if (declared.has(a.arn)) continue;
    added.push({
      resourceType: 'AWS::Lambda::Alias',
      identifier: a.arn, // the AliasArn IS the CC primaryIdentifier
      label: a.label ?? a.arn,
      live: { AliasArn: a.arn },
    });
  }
  return added;
}

async function pageLambdaAliases(
  client: LambdaClient,
  functionName: string
): Promise<LambdaAliasConfiguration[]> {
  const out: LambdaAliasConfiguration[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new ListLambdaAliasesCommand({ FunctionName: functionName, Marker: marker })
    );
    out.push(...(res.Aliases ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

// Pure diff: declared version arns + live inventory -> the added versions.
export function diffLambdaFunctionVersions(input: {
  declaredVersionArns: string[];
  liveVersions: { arn: string; label?: string | undefined }[];
}): AddedChild[] {
  const declared = new Set(input.declaredVersionArns);
  const added: AddedChild[] = [];
  for (const v of input.liveVersions) {
    if (declared.has(v.arn)) continue;
    added.push({
      resourceType: 'AWS::Lambda::Version',
      identifier: v.arn, // the versioned FunctionArn IS the CC primaryIdentifier
      label: v.label ?? v.arn,
      live: { FunctionArn: v.arn },
    });
  }
  return added;
}

async function pageLambdaVersions(
  client: LambdaClient,
  functionName: string
): Promise<LambdaVersionConfiguration[]> {
  const out: LambdaVersionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker: marker })
    );
    out.push(...(res.Versions ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

export async function enumerateLambdaFunctionChildren(
  ctx: EnumeratorContext
): Promise<AddedChild[]> {
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
    // An ESM bound to an alias/version declares a QUALIFIED FunctionName (`fn:prod`,
    // `arn:…:function:fn:prod`); compare on the UNQUALIFIED function identity so the
    // declared alias-bound ESM matches this parent function (#803).
    if (lambdaFunctionRefMatches(fn, functionName, fnArn)) {
      declaredMappingIds.push(r.physicalId);
    }
  }

  // Declared function URLs targeting THIS function. An AWS::Lambda::Url's physical id
  // (Ref) IS the URL config's FunctionArn; its TargetFunctionArn resolves to the function
  // name or ARN. Match by physicalId (the FunctionArn), and also tolerate matching by the
  // target function (a URL whose TargetFunctionArn resolves to this function's name/arn),
  // falling back to physicalId.
  const declaredUrlArns: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Lambda::Url') continue;
    const target = r.declared.TargetFunctionArn;
    // Normalize BOTH sides to the unqualified function identity so the documented partial-ARN
    // FunctionName form (`123456789012:function:my-fn`) matches this parent (#1281, #803).
    const targetsThis = lambdaFunctionRefMatches(target, functionName, fnArn);
    if (targetsThis) {
      // The URL's FunctionArn (its primaryIdentifier) is the function's bare ARN for an
      // unqualified URL; prefer the resolved live function ARN, else the declared physicalId.
      if (fnArn !== undefined) declaredUrlArns.push(fnArn);
      if (r.physicalId) declaredUrlArns.push(r.physicalId);
    } else if (r.physicalId) {
      declaredUrlArns.push(r.physicalId);
    }
  }

  // Declared aliases targeting THIS function. An AWS::Lambda::Alias's CFn physical id
  // (Ref) IS its AliasArn; its FunctionName resolves (via gather) to the function name or
  // ARN. Match on the FunctionName targeting this function; parentRefMatches also keeps an
  // alias whose FunctionName is UNRESOLVED (FunctionName is REQUIRED, so it is never
  // genuinely absent — the earlier `fn === undefined` fail-safe was dead code, #962), so a
  // resolved-id mismatch never causes a declared alias to be flagged added.
  const declaredAliasArns: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Lambda::Alias' || !r.physicalId) continue;
    // Same unqualified-identity match as the ESM/Version paths: an alias whose declared
    // FunctionName is a partial ARN (`123456789012:function:my-fn`) or a qualified ref still
    // targets this parent function (#1281, #803). Keeps the UNRESOLVED fail-safe.
    if (lambdaFunctionRefMatches(r.declared.FunctionName, functionName, fnArn)) {
      declaredAliasArns.push(r.physicalId);
    }
  }

  // Declared versions targeting THIS function. An AWS::Lambda::Version's CFn physical id
  // (Ref) IS its versioned FunctionArn; its FunctionName resolves (via gather) to the
  // function name or ARN. Match on the FunctionName targeting this function; parentRefMatches
  // also keeps a version whose FunctionName is UNRESOLVED (the earlier `fn === undefined`
  // fail-safe was dead code — FunctionName is REQUIRED, #962), so a resolved-id mismatch
  // never causes a declared version to be flagged added.
  const declaredVersionArns: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Lambda::Version' || !r.physicalId) continue;
    // Same unqualified-identity match as the ESM path: a Version whose declared
    // FunctionName carries a qualifier still targets this parent function (#803).
    if (lambdaFunctionRefMatches(r.declared.FunctionName, functionName, fnArn)) {
      declaredVersionArns.push(r.physicalId);
    }
  }

  const client = new LambdaClient({ region, ...READ_RETRY });
  const mappings = await pageEventSourceMappings(client, functionName);
  const liveMappings = mappings
    .filter(
      (m): m is EventSourceMappingConfiguration & { UUID: string } => typeof m.UUID === 'string'
    )
    .map((m) => ({ id: m.UUID, label: m.EventSourceArn ?? m.UUID }));

  const esmAdded = diffLambdaFunctionChildren({ declaredMappingIds, liveMappings });

  const urlConfigs = await pageFunctionUrlConfigs(client, functionName);
  const liveUrls = urlConfigs
    .filter(
      (u): u is FunctionUrlConfig & { FunctionArn: string } => typeof u.FunctionArn === 'string'
    )
    .map((u) => ({
      arn: u.FunctionArn,
      label: u.AuthType ? `${u.AuthType} ${u.FunctionArn}` : u.FunctionArn,
    }));

  const urlAdded = diffLambdaFunctionUrls({ declaredUrlArns, liveUrls });

  const aliases = await pageLambdaAliases(client, functionName);
  const liveAliases = aliases
    .filter(
      (a): a is LambdaAliasConfiguration & { AliasArn: string } => typeof a.AliasArn === 'string'
    )
    .map((a) => ({ arn: a.AliasArn, label: a.Name ? `${a.Name} ${a.AliasArn}` : a.AliasArn }));

  const aliasAdded = diffLambdaFunctionAliases({ declaredAliasArns, liveAliases });

  const versions = await pageLambdaVersions(client, functionName);
  const liveVersions = versions
    .filter(
      (v): v is LambdaVersionConfiguration & { FunctionArn: string } =>
        typeof v.FunctionArn === 'string' && v.Version !== '$LATEST' // skip the $LATEST pseudo-version
    )
    .map((v) => ({
      arn: v.FunctionArn,
      label: v.Version ? `v${v.Version}` : v.FunctionArn,
    }));

  const versionAdded = diffLambdaFunctionVersions({ declaredVersionArns, liveVersions });

  return [...esmAdded, ...urlAdded, ...aliasAdded, ...versionAdded];
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
  busName: string; // the live bus name (a custom-bus rule's CFn physical id is `<busName>|<ruleName>`)
  isDefaultBus: boolean; // the AWS-default bus stores the bare `<ruleName>` (no bus prefix)
  declaredRuleNames: string[]; // bare Names of AWS::Events::Rule declared on this bus
  liveRules: { name: string; arn: string; label?: string | undefined }[];
}

export function diffEventBusChildren(input: EventBusChildInput): AddedChild[] {
  const declared = new Set(input.declaredRuleNames);
  const added: AddedChild[] = [];
  for (const r of input.liveRules) {
    if (declared.has(r.name)) continue;
    // The CFn physical id for the sibling-stack lookup (#895): the bare rule name on the
    // AWS-default bus, the `<busName>|<ruleName>` composite on a custom bus. The CC
    // `identifier` stays the Arn (that is what GetResource / DeleteResource consume).
    const siblingLookupId = input.isDefaultBus ? r.name : `${input.busName}|${r.name}`;
    added.push({
      resourceType: 'AWS::Events::Rule',
      identifier: r.arn, // the rule Arn IS the CC primaryIdentifier
      label: r.label ?? r.name,
      live: { Name: r.name, Arn: r.arn },
      siblingLookupId,
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
    if (!parentRefMatches(bus, busName, busArn)) continue;
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

  // CFn stores a rule's physical id as `<busName>|<ruleName>` on a custom bus, but the bare
  // `<ruleName>` on the AWS-default bus (whose name is the literal `default`). Only declared
  // custom buses are scanned here, so `busName` is virtually never `default`; handle both so
  // the sibling-stack lookup id matches CFn's physical id regardless (#895).
  const isDefaultBus = busName === 'default';

  return diffEventBusChildren({ busName, isDefaultBus, declaredRuleNames, liveRules });
}

// ── Cognito ──────────────────────────────────────────────────────────────────
// An `AWS::Cognito::UserPool` owns UserPoolClients (app clients), each a separate
// CloudFormation resource. A console / CLI `create-user-pool-client` (someone wires a
// new app client to a pool out of band) is invisible to cdk drift / CFn drift detection
// (they only compare template-declared resources). The UserPool's own live model does
// NOT reflect its clients, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::Cognito::UserPoolClient is the composite
// `["/properties/UserPoolId","/properties/ClientId"]`, so the `identifier` is the
// composite `UserPoolId|ClientId` — that is what CC GetResource / DeleteResource consume.

// The OpenSearch/Elasticsearch service auto-creates an app client in a declared user
// pool when OpenSearch Dashboards Cognito auth is enabled (`CognitoOptions` on the
// domain / CDK `cognitoDashboardsAuth`) — documented behavior. The client is named with
// a service prefix; the service was renamed, so BOTH the legacy Elasticsearch prefix and
// the current OpenSearch Service prefix are matched. This is NOT an out-of-band add — it
// is created by another AWS service on the user's behalf, and Dashboards auth DEPENDS on
// it (offering to DELETE it would break auth). It belongs to no stack, so the
// sibling-stack check cannot rescue it. Gating only on this documented prefix preserves
// out-of-band detection: a rogue client with an ordinary name still surfaces (#897).
const OPENSEARCH_SERVICE_CLIENT_PREFIXES = ['AWSElasticsearch-', 'AmazonOpenSearchService-'];

function isOpenSearchServiceClient(name: string | undefined): boolean {
  if (name === undefined) return false;
  return OPENSEARCH_SERVICE_CLIENT_PREFIXES.some((p) => name.startsWith(p));
}

// Pure diff: declared client ids + live inventory -> the added clients.
export interface UserPoolChildInput {
  userPoolId: string;
  declaredClientIds: string[]; // physical ids (ClientIds) of AWS::Cognito::UserPoolClient
  liveClients: { id: string; name?: string | undefined; label?: string | undefined }[];
}

export function diffUserPoolChildren(input: UserPoolChildInput): AddedChild[] {
  const { userPoolId, declaredClientIds, liveClients } = input;
  const declared = new Set(declaredClientIds);
  const added: AddedChild[] = [];
  for (const c of liveClients) {
    if (declared.has(c.id)) continue;
    // Skip the OpenSearch/Elasticsearch service-created Dashboards-auth client (#897).
    if (isOpenSearchServiceClient(c.name ?? c.label)) continue;
    added.push({
      resourceType: 'AWS::Cognito::UserPoolClient',
      identifier: `${userPoolId}|${c.id}`, // CC composite UserPoolId|ClientId
      label: c.label ?? c.id,
      live: { ClientId: c.id },
    });
  }
  return added;
}

async function pageUserPoolClients(
  client: CognitoIdentityProviderClient,
  userPoolId: string
): Promise<UserPoolClientDescription[]> {
  const out: UserPoolClientDescription[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListUserPoolClientsCommand({ UserPoolId: userPoolId, NextToken: next, MaxResults: 60 })
    );
    out.push(...(res.UserPoolClients ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

// A UserPool also owns UserPoolGroups, each a separate CloudFormation resource. A
// console / CLI `create-group` (someone wires a new group onto a pool out of band) is
// invisible to cdk drift / CFn drift detection. The UserPool model does NOT reflect its
// groups inline, so there is no double-report to suppress. The CC primaryIdentifier for
// AWS::Cognito::UserPoolGroup is the composite `["/properties/UserPoolId","/properties/GroupName"]`,
// so the `identifier` is the composite `UserPoolId|GroupName` — that is what CC
// GetResource / DeleteResource consume. A group's CFn physical id (Ref) IS its GroupName.

// Pure diff: declared group names + live inventory -> the added groups.
export interface UserPoolGroupInput {
  userPoolId: string;
  declaredGroupNames: string[]; // physical ids (GroupNames) of AWS::Cognito::UserPoolGroup
  // ProviderNames of AWS::Cognito::UserPoolIdentityProvider declared on this pool.
  // When a federated user first signs in through one of these, Cognito auto-creates a
  // `<userPoolId>_<ProviderName>` group (documented behavior) — that is NOT an
  // out-of-band add, so it is skipped (#961). Gating on the DECLARED set preserves
  // out-of-band detection: an auto-group for an IdP the template never declared still
  // surfaces.
  declaredProviderNames: string[];
  // `roleArn` carries the live group's ListGroups `Group.RoleArn`. The genuine
  // Cognito-auto-created federated group is created BARE (no RoleArn). An attacker with
  // cognito-idp:CreateGroup can pre-create the exact `<userPoolId>_<ProviderName>` name WITH
  // a RoleArn → every federated user of that IdP is auto-added to it on sign-in → via
  // identity-pool `preferred_role` resolution they assume the attached role (federated
  // privilege escalation). So the #961 auto-group skip is GATED on `roleArn === undefined` —
  // a name-matched group that carries a RoleArn is NOT the benign auto-group and surfaces as
  // added (#1262).
  liveGroups: {
    name: string;
    label?: string | undefined;
    roleArn?: string | undefined;
  }[];
}

export function diffUserPoolGroups(input: UserPoolGroupInput): AddedChild[] {
  const { userPoolId, declaredGroupNames, declaredProviderNames, liveGroups } = input;
  const declared = new Set(declaredGroupNames);
  // The set of provider names whose `<userPoolId>_<ProviderName>` auto-group is
  // legitimate: any DECLARED IdP provider name, PLUS the built-in social provider names
  // Cognito uses (but only when they are ACTUALLY declared — a declared social IdP
  // surfaces its provider name in declaredProviderNames). Only declared providers gate a
  // skip, so an undeclared IdP's auto-group is still surfaced.
  const autoGroupNames = new Set<string>();
  for (const p of declaredProviderNames) {
    if (typeof p === 'string' && p.length > 0) autoGroupNames.add(`${userPoolId}_${p}`);
  }
  const added: AddedChild[] = [];
  for (const g of liveGroups) {
    if (declared.has(g.name)) continue;
    // Skip the Cognito-auto-created federated group (#961) ONLY when it looks auto-created:
    // the genuine lazy auto-group is BARE (no RoleArn). A `<userPoolId>_<ProviderName>`-named
    // group WITH a RoleArn is an out-of-band privilege-escalation group, not the benign
    // auto-group → surface it as added (#1262).
    if (autoGroupNames.has(g.name) && g.roleArn === undefined) continue;
    added.push({
      resourceType: 'AWS::Cognito::UserPoolGroup',
      identifier: `${userPoolId}|${g.name}`, // CC composite UserPoolId|GroupName
      label: g.label ?? g.name,
      live: {
        GroupName: g.name,
        UserPoolId: userPoolId,
        ...(g.roleArn !== undefined ? { RoleArn: g.roleArn } : {}),
      },
    });
  }
  return added;
}

async function pageUserPoolGroups(
  client: CognitoIdentityProviderClient,
  userPoolId: string
): Promise<GroupType[]> {
  const out: GroupType[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListGroupsCommand({ UserPoolId: userPoolId, NextToken: next, Limit: 60 })
    );
    out.push(...(res.Groups ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

// A UserPool also owns UserPoolResourceServers, each a separate CloudFormation resource. A
// console / CLI `create-resource-server` (someone wires a new OAuth resource server onto a
// pool out of band) is invisible to cdk drift / CFn drift detection. The UserPool model does
// NOT reflect its resource servers inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::Cognito::UserPoolResourceServer is the composite
// `["/properties/UserPoolId","/properties/Identifier"]`, so the `identifier` is the composite
// `UserPoolId|Identifier` — that is what CC GetResource / DeleteResource consume.

// Pure diff: declared resource server identifiers + live inventory -> the added resource servers.
export interface UserPoolResourceServerInput {
  userPoolId: string;
  declaredIdentifiers: string[]; // Identifier values of AWS::Cognito::UserPoolResourceServer
  liveResourceServers: { identifier: string; label?: string | undefined }[];
}

export function diffUserPoolResourceServers(input: UserPoolResourceServerInput): AddedChild[] {
  const { userPoolId, declaredIdentifiers, liveResourceServers } = input;
  const declared = new Set(declaredIdentifiers);
  const added: AddedChild[] = [];
  for (const rs of liveResourceServers) {
    if (declared.has(rs.identifier)) continue;
    added.push({
      resourceType: 'AWS::Cognito::UserPoolResourceServer',
      identifier: `${userPoolId}|${rs.identifier}`, // CC composite UserPoolId|Identifier
      label: rs.label ?? rs.identifier,
      live: { Identifier: rs.identifier, UserPoolId: userPoolId },
    });
  }
  return added;
}

async function pageUserPoolResourceServers(
  client: CognitoIdentityProviderClient,
  userPoolId: string
): Promise<ResourceServerType[]> {
  const out: ResourceServerType[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListResourceServersCommand({ UserPoolId: userPoolId, NextToken: next, MaxResults: 50 })
    );
    out.push(...(res.ResourceServers ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

// A UserPool also owns UserPoolIdentityProviders (the SAML / OIDC / Google / Facebook /
// LoginWithAmazon / SignInWithApple federated IdPs wired onto the pool), each a separate
// CloudFormation resource. A console / CLI `create-identity-provider` (someone wires a
// rogue SAML / OIDC / social IdP onto a pool out of band) is invisible to cdk drift / CFn
// drift detection — an auth backdoor that reads CLEAN (#1043). The UserPool model does NOT
// reflect its IdPs inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::Cognito::UserPoolIdentityProvider is the composite
// `["/properties/UserPoolId","/properties/ProviderName"]`, so the `identifier` is the
// composite `UserPoolId|ProviderName` — that is what CC GetResource / DeleteResource
// consume. An IdP's CFn physical id (Ref) IS its ProviderName.

// Cognito auto-creates a built-in `Cognito` provider (the pool's own native users) where
// hosted UI is enabled — never an out-of-band add, so it is filtered (like the API GW
// `Empty`/`Error` built-in models). The social / SAML / OIDC providers are user-declared
// or rogue and are NOT filtered.
const BUILTIN_COGNITO_PROVIDER_NAME = 'Cognito';

// Pure diff: declared provider names + live inventory -> the added identity providers.
export interface UserPoolIdentityProviderInput {
  userPoolId: string;
  // ProviderNames (Ref/physical id) of AWS::Cognito::UserPoolIdentityProvider declared on this pool.
  declaredProviderNames: string[];
  liveProviders: { providerName: string; label?: string | undefined }[];
}

export function diffUserPoolIdentityProviders(input: UserPoolIdentityProviderInput): AddedChild[] {
  const { userPoolId, declaredProviderNames, liveProviders } = input;
  const declared = new Set(declaredProviderNames);
  const added: AddedChild[] = [];
  for (const p of liveProviders) {
    // The built-in `Cognito` native-users provider is AWS-managed — never an out-of-band add.
    if (p.providerName === BUILTIN_COGNITO_PROVIDER_NAME) continue;
    if (declared.has(p.providerName)) continue;
    added.push({
      resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
      identifier: `${userPoolId}|${p.providerName}`, // CC composite UserPoolId|ProviderName
      label: p.label ?? p.providerName,
      live: { ProviderName: p.providerName, UserPoolId: userPoolId },
    });
  }
  return added;
}

async function pageUserPoolIdentityProviders(
  client: CognitoIdentityProviderClient,
  userPoolId: string
): Promise<ProviderDescription[]> {
  const out: ProviderDescription[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListIdentityProvidersCommand({ UserPoolId: userPoolId, NextToken: next, MaxResults: 60 })
    );
    out.push(...(res.Providers ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateUserPoolChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const userPoolId = parent.physicalId; // a UserPool's physical id IS its UserPoolId
  if (!userPoolId) return [];

  // Declared clients of THIS pool (Ref/GetAtt UserPoolId already resolved to the physical
  // id by gather). A client's physical id IS its ClientId.
  const declaredClientIds: string[] = [];
  // Declared groups of THIS pool. A group's physical id IS its GroupName.
  const declaredGroupNames: string[] = [];
  // Declared resource servers of THIS pool. Matched by the Identifier value.
  const declaredResourceServerIdentifiers: string[] = [];
  // Declared identity providers of THIS pool. Matched by the ProviderName (Ref/physical id).
  const declaredProviderNames: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::Cognito::UserPoolClient' &&
      parentRefMatches(r.declared.UserPoolId, userPoolId) &&
      r.physicalId
    ) {
      declaredClientIds.push(r.physicalId);
    } else if (
      r.resourceType === 'AWS::Cognito::UserPoolGroup' &&
      parentRefMatches(r.declared.UserPoolId, userPoolId)
    ) {
      const name = typeof r.declared.GroupName === 'string' ? r.declared.GroupName : r.physicalId;
      if (name) declaredGroupNames.push(name);
    } else if (
      r.resourceType === 'AWS::Cognito::UserPoolResourceServer' &&
      parentRefMatches(r.declared.UserPoolId, userPoolId)
    ) {
      const identifier =
        typeof r.declared.Identifier === 'string' ? r.declared.Identifier : r.physicalId;
      if (identifier) declaredResourceServerIdentifiers.push(identifier);
    } else if (
      r.resourceType === 'AWS::Cognito::UserPoolIdentityProvider' &&
      parentRefMatches(r.declared.UserPoolId, userPoolId)
    ) {
      const providerName =
        typeof r.declared.ProviderName === 'string' ? r.declared.ProviderName : r.physicalId;
      if (providerName) declaredProviderNames.push(providerName);
    }
  }

  const client = new CognitoIdentityProviderClient({ region, ...READ_RETRY });

  const clients = await pageUserPoolClients(client, userPoolId);
  const liveClients = clients
    .filter(
      (c): c is UserPoolClientDescription & { ClientId: string } => typeof c.ClientId === 'string'
    )
    .map((c) => ({ id: c.ClientId, name: c.ClientName, label: c.ClientName ?? c.ClientId }));
  const clientAdded = diffUserPoolChildren({ userPoolId, declaredClientIds, liveClients });

  const groups = await pageUserPoolGroups(client, userPoolId);
  const liveGroups = groups
    .filter((g): g is GroupType & { GroupName: string } => typeof g.GroupName === 'string')
    .map((g) => ({ name: g.GroupName, roleArn: g.RoleArn }));
  const groupAdded = diffUserPoolGroups({
    userPoolId,
    declaredGroupNames,
    declaredProviderNames,
    liveGroups,
  });

  const resourceServers = await pageUserPoolResourceServers(client, userPoolId);
  const liveResourceServers = resourceServers
    .filter(
      (rs): rs is ResourceServerType & { Identifier: string } => typeof rs.Identifier === 'string'
    )
    .map((rs) => ({ identifier: rs.Identifier, label: rs.Name ?? rs.Identifier }));
  const resourceServerAdded = diffUserPoolResourceServers({
    userPoolId,
    declaredIdentifiers: declaredResourceServerIdentifiers,
    liveResourceServers,
  });

  const providers = await pageUserPoolIdentityProviders(client, userPoolId);
  const liveProviders = providers
    .filter(
      (p): p is ProviderDescription & { ProviderName: string } => typeof p.ProviderName === 'string'
    )
    .map((p) => ({ providerName: p.ProviderName, label: p.ProviderName }));
  const idpAdded = diffUserPoolIdentityProviders({
    userPoolId,
    declaredProviderNames,
    liveProviders,
  });

  return [...clientAdded, ...groupAdded, ...resourceServerAdded, ...idpAdded];
}

// ── AppSync ──────────────────────────────────────────────────────────────────
// An `AWS::AppSync::GraphQLApi` owns DataSources (the DynamoDB / Lambda / HTTP / NONE
// resolver backings), Resolvers (per type/field attachments), Functions (the pipeline
// functions composed into a pipeline resolver), AND ApiKeys (the API_KEY-auth
// credentials), each a separate CloudFormation resource. A console / CLI
// `create-data-source` / `create-resolver` / `create-function` / `create-api-key`
// (someone wires a new backing, resolver, function, or — security-relevant — a durable
// API_KEY auth credential onto an api out of band) is invisible to cdk drift / CFn drift
// detection. The GraphQLApi model does NOT reflect its datasources, resolvers, functions,
// or api keys inline, so there is no double-report to suppress. The CC primaryIdentifier
// for AWS::AppSync::DataSource is the bare DataSourceArn, for AWS::AppSync::Resolver the
// bare ResolverArn, for AWS::AppSync::FunctionConfiguration the bare FunctionArn, and for
// AWS::AppSync::ApiKey the bare ApiKeyId, which CC GetResource / DeleteResource consume.

// Pure diff: declared datasource names + live inventory -> the added datasources.
export interface GraphQLApiChildInput {
  declaredDataSourceNames: string[]; // Names of AWS::AppSync::DataSource declared on this api
  liveDataSources: { name: string; arn: string; label?: string | undefined }[];
  // Fail-safe (#1089): a declared datasource's identity (Name) was UNRESOLVED, so it could not
  // be matched against the live datasources — suppress ALL added for this api (a `revert
  // --remove-unrecorded` would otherwise DeleteResource a declared datasource).
  hasUnresolvedDeclaredDataSource?: boolean;
}

export function diffGraphQLApiChildren(input: GraphQLApiChildInput): AddedChild[] {
  if (input.hasUnresolvedDeclaredDataSource) return [];
  const declared = new Set(input.declaredDataSourceNames);
  const added: AddedChild[] = [];
  for (const ds of input.liveDataSources) {
    if (declared.has(ds.name)) continue;
    added.push({
      resourceType: 'AWS::AppSync::DataSource',
      identifier: ds.arn, // DataSourceArn IS the CC primaryIdentifier
      label: ds.label ?? ds.name,
      live: { Name: ds.name, DataSourceArn: ds.arn },
    });
  }
  return added;
}

async function pageDataSources(client: AppSyncClient, apiId: string): Promise<AppSyncDataSource[]> {
  const out: AppSyncDataSource[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListDataSourcesCommand({ apiId, nextToken: next }));
    out.push(...(res.dataSources ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

// Pure diff: declared resolver keys (`${typeName}|${fieldName}`) + live inventory ->
// the added resolvers. Declared resolvers are matched by their typeName|fieldName key
// (the physical-id form is unreliable); an added resolver's identifier is its live
// ResolverArn (the CC primaryIdentifier).
export interface GraphQLApiResolverInput {
  declaredResolverKeys: string[]; // `${typeName}|${fieldName}` of declared AWS::AppSync::Resolver
  liveResolvers: { key: string; arn: string; label?: string | undefined }[];
  // Fail-safe (#1089): a declared resolver's identity (TypeName/FieldName) was UNRESOLVED, so it
  // could not be matched against the live resolvers — suppress ALL added for this api.
  hasUnresolvedDeclaredResolver?: boolean;
}

export function diffGraphQLApiResolvers(input: GraphQLApiResolverInput): AddedChild[] {
  if (input.hasUnresolvedDeclaredResolver) return [];
  const declared = new Set(input.declaredResolverKeys);
  const added: AddedChild[] = [];
  for (const r of input.liveResolvers) {
    if (declared.has(r.key)) continue;
    added.push({
      resourceType: 'AWS::AppSync::Resolver',
      identifier: r.arn, // ResolverArn IS the CC primaryIdentifier
      label: r.label ?? r.key,
      live: { ResolverArn: r.arn },
    });
  }
  return added;
}

async function pageTypes(client: AppSyncClient, apiId: string): Promise<string[]> {
  const out: string[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListTypesCommand({ apiId, format: 'SDL', nextToken: next }));
    for (const t of res.types ?? []) {
      if (typeof t.name === 'string') out.push(t.name);
    }
    next = res.nextToken;
  } while (next);
  return out;
}

async function pageResolvers(
  client: AppSyncClient,
  apiId: string,
  typeName: string
): Promise<AppSyncResolver[]> {
  const out: AppSyncResolver[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListResolversCommand({ apiId, typeName, nextToken: next }));
    out.push(...(res.resolvers ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

// Pure diff: declared function arns + live inventory -> the added functions. A declared
// AWS::AppSync::FunctionConfiguration's CFn physical id (Ref) IS its FunctionArn, so
// declared functions are matched by FunctionArn; an added function's identifier is its
// live FunctionArn (the CC primaryIdentifier).
export interface GraphQLApiFunctionInput {
  declaredFunctionArns: string[]; // physical ids (FunctionArns) of AWS::AppSync::FunctionConfiguration
  liveFunctions: { arn: string; label?: string | undefined }[];
}

export function diffGraphQLApiFunctions(input: GraphQLApiFunctionInput): AddedChild[] {
  const declared = new Set(input.declaredFunctionArns);
  const added: AddedChild[] = [];
  for (const f of input.liveFunctions) {
    if (declared.has(f.arn)) continue;
    added.push({
      resourceType: 'AWS::AppSync::FunctionConfiguration',
      identifier: f.arn, // FunctionArn IS the CC primaryIdentifier
      label: f.label ?? f.arn,
      live: { FunctionArn: f.arn },
    });
  }
  return added;
}

async function pageAppSyncFunctions(
  client: AppSyncClient,
  apiId: string
): Promise<AppSyncFunctionConfiguration[]> {
  const out: AppSyncFunctionConfiguration[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListAppSyncFunctionsCommand({ apiId, nextToken: next }));
    out.push(...(res.functions ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

// An `AWS::AppSync::ApiKey` is a durable API_KEY-auth credential — a console / CLI
// `appsync create-api-key` mints one out of band that cdk drift / CFn drift detection
// cannot see (#1367; #965 covered only the DELETE direction of an api key). AppSync does
// NOT auto-materialize a default key for a bare API_KEY-auth GraphQLApi — a key exists
// ONLY via CreateApiKey or a declared AWS::AppSync::ApiKey (the CDK `GraphqlApi`
// construct's auto-key IS a declared CfnApiKey in the template) — so a live key not
// matching a declared one is genuinely out of band and needs no built-in default filter
// (unlike the RestApi `Empty`/`Error` models). The CC primaryIdentifier is the SINGLE
// `/properties/ApiKeyId` (confirmed via describe-type) whose runtime form is the BARE key
// id — identical to ListApiKeys' `id`. A declared ApiKey's CFn physical id (Ref) is the
// ARN `arn:...:apis/<apiId>/apikey[s]/<keyId>`, so declared keys are matched by the bare
// key id extracted from that ARN (fall back to a bare id if gather resolved it as such).

// Extract the BARE ApiKeyId (the ListApiKeys / CC primaryIdentifier form) from a declared
// AWS::AppSync::ApiKey physical id: its ARN's trailing `apikey[s]/<keyId>` segment. A bare
// id (no `/`) passes through unchanged in case gather resolved the Ref to the bare form.
function bareApiKeyId(physicalId: string): string {
  return physicalId.includes('/') ? physicalId.slice(physicalId.lastIndexOf('/') + 1) : physicalId;
}

// Pure diff: declared api key ids + live inventory -> the added api keys. A declared
// AWS::AppSync::ApiKey is matched by its bare ApiKeyId; an added key's identifier is its
// live bare ApiKeyId (the CC primaryIdentifier).
export interface GraphQLApiApiKeyInput {
  declaredApiKeyIds: string[]; // bare ApiKeyIds of AWS::AppSync::ApiKey declared on this api
  liveApiKeys: { id: string; label?: string | undefined }[];
  // Fail-safe (#1089): a declared api key's identity (the bare ApiKeyId, parsed from its
  // physical-id ARN) was UNRESOLVED, so it could not be matched against the live keys —
  // suppress ALL added for this api (a `revert --remove-unrecorded` would otherwise
  // DeleteResource a declared api key).
  hasUnresolvedDeclaredApiKey?: boolean;
}

export function diffGraphQLApiApiKeys(input: GraphQLApiApiKeyInput): AddedChild[] {
  if (input.hasUnresolvedDeclaredApiKey) return [];
  const declared = new Set(input.declaredApiKeyIds);
  const added: AddedChild[] = [];
  for (const k of input.liveApiKeys) {
    if (declared.has(k.id)) continue;
    added.push({
      resourceType: 'AWS::AppSync::ApiKey',
      identifier: k.id, // bare ApiKeyId IS the CC primaryIdentifier
      label: k.label ?? k.id,
      live: { ApiKeyId: k.id },
    });
  }
  return added;
}

async function pageApiKeys(client: AppSyncClient, apiId: string): Promise<AppSyncApiKey[]> {
  const out: AppSyncApiKey[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListApiKeysCommand({ apiId, nextToken: next }));
    out.push(...(res.apiKeys ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

// A GraphQLApi's CFn physical id is its ARN (`arn:...:apis/<apiId>`), but `ListDataSources`
// and a DataSource's declared `ApiId` (`Fn::GetAtt ApiId`) both use the BARE api id. Take
// the trailing `apis/<id>` segment when the physical id is an ARN; otherwise it already IS
// the bare id (the CC primaryIdentifier form).
function bareApiId(physicalId: string): string {
  return physicalId.includes('/') ? physicalId.slice(physicalId.lastIndexOf('/') + 1) : physicalId;
}

async function enumerateGraphQLApiChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  if (!parent.physicalId) return [];
  const apiId = bareApiId(parent.physicalId); // the BARE ApiId (ListDataSources / declared ApiId form)

  // Declared datasources on THIS api. Datasource names are unique per api, and the
  // Ref/physical-id form is unreliable, so match DECLARED datasources by Name. A declared
  // DataSource's ApiId (Fn::GetAtt ApiId, resolved by gather) is the bare api id; tolerate
  // an ARN form too in case gather resolved it differently.
  const declaredDataSourceNames: string[] = [];
  // Fail-safe: a declared datasource whose IDENTITY (Name) is UNRESOLVED can't be matched
  // against the live datasources by name — suppress datasource added-reporting for this api
  // rather than false-flag every live datasource as `added` with a DeleteResource offer
  // (#1089, the identity-prop half of #962; #1016 covered only the parent ApiId ref).
  let datasourceNameUnresolved = false;
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::AppSync::DataSource') continue;
    // Fail-safe: an UNRESOLVED ApiId (dynamic ref / no-default Param / degraded ImportValue)
    // must not exclude a declared datasource (#962); only a RESOLVED, non-matching id does.
    const declaredApiId = r.declared.ApiId;
    if (declaredApiId !== UNRESOLVED && !hasUnresolved(declaredApiId)) {
      if (typeof declaredApiId !== 'string' || bareApiId(declaredApiId) !== apiId) continue;
    }
    if (r.declared.Name === UNRESOLVED || hasUnresolved(r.declared.Name)) {
      datasourceNameUnresolved = true;
      continue;
    }
    if (typeof r.declared.Name !== 'string') continue;
    declaredDataSourceNames.push(r.declared.Name);
  }

  // Declared resolvers on THIS api. Resolvers are attached per (type, field); match
  // DECLARED resolvers by the `${typeName}|${fieldName}` key (the physical-id form is
  // unreliable). A declared Resolver's ApiId (Fn::GetAtt ApiId) is the bare api id;
  // tolerate an ARN form too in case gather resolved it differently.
  const declaredResolverKeys: string[] = [];
  // Fail-safe: a declared resolver whose IDENTITY (TypeName/FieldName) is UNRESOLVED can't be
  // matched against the live resolvers — suppress resolver added-reporting for this api (#1089).
  let resolverKeyUnresolved = false;
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::AppSync::Resolver') continue;
    // Fail-safe: an UNRESOLVED ApiId must not exclude a declared resolver (#962).
    const declaredApiId = r.declared.ApiId;
    if (declaredApiId !== UNRESOLVED && !hasUnresolved(declaredApiId)) {
      if (typeof declaredApiId !== 'string' || bareApiId(declaredApiId) !== apiId) continue;
    }
    const { TypeName, FieldName } = r.declared;
    if (
      TypeName === UNRESOLVED ||
      hasUnresolved(TypeName) ||
      FieldName === UNRESOLVED ||
      hasUnresolved(FieldName)
    ) {
      resolverKeyUnresolved = true;
      continue;
    }
    if (typeof TypeName !== 'string' || typeof FieldName !== 'string') continue;
    declaredResolverKeys.push(`${TypeName}|${FieldName}`);
  }

  // Declared functions on THIS api. An AWS::AppSync::FunctionConfiguration's CFn physical
  // id (Ref) IS its FunctionArn, so match DECLARED functions by FunctionArn (= physicalId).
  // A declared Function's ApiId (Fn::GetAtt ApiId, resolved by gather) is the bare api id;
  // tolerate an ARN form too in case gather resolved it differently.
  const declaredFunctionArns: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::AppSync::FunctionConfiguration' || !r.physicalId) continue;
    // Fail-safe: an UNRESOLVED ApiId must not exclude a declared function (#962).
    const declaredApiId = r.declared.ApiId;
    if (declaredApiId !== UNRESOLVED && !hasUnresolved(declaredApiId)) {
      if (typeof declaredApiId !== 'string' || bareApiId(declaredApiId) !== apiId) continue;
    }
    declaredFunctionArns.push(r.physicalId);
  }

  // Declared api keys on THIS api. An AWS::AppSync::ApiKey's CFn physical id (Ref) is the
  // ARN `arn:...:apis/<apiId>/apikey[s]/<keyId>`, so match DECLARED keys by the BARE
  // ApiKeyId parsed from that ARN (= the ListApiKeys / CC primaryIdentifier form). A
  // declared ApiKey's ApiId (Ref graphQlApiId, resolved by gather) is the bare api id;
  // tolerate an ARN form too in case gather resolved it differently.
  const declaredApiKeyIds: string[] = [];
  // Fail-safe: a declared api key whose IDENTITY (physical id) is UNRESOLVED can't be matched
  // against the live keys — suppress api-key added-reporting for this api rather than
  // false-flag every live key as `added` with a DeleteResource offer (#1089).
  let apiKeyIdUnresolved = false;
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::AppSync::ApiKey') continue;
    // Fail-safe: an UNRESOLVED ApiId must not exclude a declared api key (#962).
    const declaredApiId = r.declared.ApiId;
    if (declaredApiId !== UNRESOLVED && !hasUnresolved(declaredApiId)) {
      if (typeof declaredApiId !== 'string' || bareApiId(declaredApiId) !== apiId) continue;
    }
    // The identity of a declared ApiKey is its physical id (the CFn Ref ARN, from which the
    // bare ApiKeyId is parsed). When gather could not resolve it (dynamic ref / no-default
    // Param / degraded ImportValue), it is absent — fail safe: suppress ALL added for this api.
    if (!r.physicalId) {
      apiKeyIdUnresolved = true;
      continue;
    }
    declaredApiKeyIds.push(bareApiKeyId(r.physicalId));
  }

  const client = new AppSyncClient({ region, ...READ_RETRY });
  const dataSources = await pageDataSources(client, apiId);
  const liveDataSources = dataSources
    .filter(
      (ds): ds is AppSyncDataSource & { name: string; dataSourceArn: string } =>
        typeof ds.name === 'string' && typeof ds.dataSourceArn === 'string'
    )
    .map((ds) => ({
      name: ds.name,
      arn: ds.dataSourceArn,
      label: ds.type ? `${ds.type} ${ds.name}` : ds.name,
    }));
  const datasourceAdded = diffGraphQLApiChildren({
    declaredDataSourceNames,
    liveDataSources,
    hasUnresolvedDeclaredDataSource: datasourceNameUnresolved,
  });

  // Resolvers are scoped per type: list all types, then list resolvers per type.
  const types = await pageTypes(client, apiId);
  const liveResolvers: { key: string; arn: string; label?: string | undefined }[] = [];
  for (const typeName of types) {
    for (const r of await pageResolvers(client, apiId, typeName)) {
      if (typeof r.resolverArn !== 'string') continue;
      if (typeof r.typeName !== 'string' || typeof r.fieldName !== 'string') continue;
      liveResolvers.push({
        key: `${r.typeName}|${r.fieldName}`,
        arn: r.resolverArn,
        label: `${r.typeName}.${r.fieldName}`,
      });
    }
  }
  const resolverAdded = diffGraphQLApiResolvers({
    declaredResolverKeys,
    liveResolvers,
    hasUnresolvedDeclaredResolver: resolverKeyUnresolved,
  });

  // Functions are listed per api (not per type).
  const functions = await pageAppSyncFunctions(client, apiId);
  const liveFunctions = functions
    .filter(
      (f): f is AppSyncFunctionConfiguration & { functionArn: string } =>
        typeof f.functionArn === 'string'
    )
    .map((f) => ({ arn: f.functionArn, label: f.name ?? f.functionArn }));
  const functionAdded = diffGraphQLApiFunctions({ declaredFunctionArns, liveFunctions });

  // Api keys are listed per api. A live key not matching a declared AWS::AppSync::ApiKey is
  // an out-of-band `appsync create-api-key` (#1367). Label with the key's description when it
  // carries one (AWS returns none/"" for an undescribed key), else the bare id.
  const apiKeys = await pageApiKeys(client, apiId);
  const liveApiKeys = apiKeys
    .filter((k): k is AppSyncApiKey & { id: string } => typeof k.id === 'string')
    .map((k) => ({ id: k.id, label: k.description ? `${k.id} (${k.description})` : k.id }));
  const apiKeyAdded = diffGraphQLApiApiKeys({
    declaredApiKeyIds,
    liveApiKeys,
    hasUnresolvedDeclaredApiKey: apiKeyIdUnresolved,
  });

  return [...datasourceAdded, ...resolverAdded, ...functionAdded, ...apiKeyAdded];
}

// ── CloudWatch Logs ────────────────────────────────────────────────────────────
// An `AWS::Logs::LogGroup` owns MetricFilters AND SubscriptionFilters, each a separate
// CloudFormation resource. A console / CLI `put-metric-filter` / `put-subscription-filter`
// (someone wires a new metric filter, or — security-relevant — a new SUBSCRIPTION filter
// streaming the log group's events to an out-of-band Lambda/Kinesis/Firehose destination)
// is invisible to cdk drift / CFn drift detection (they only compare template-declared
// resources). The LogGroup's own live model does NOT reflect either inline, so there is no
// double-report to suppress. The CC primaryIdentifier for BOTH AWS::Logs::MetricFilter and
// AWS::Logs::SubscriptionFilter is the composite `["/properties/LogGroupName",
// "/properties/FilterName"]`, so the `identifier` is `LogGroupName|FilterName`
// (LogGroupName first) — what CC GetResource / DeleteResource consume.

// Pure diff: declared filter names + live inventory -> the added filters, tagged with the
// given CFn resourceType (MetricFilter or SubscriptionFilter). Metric- and subscription-
// filter names are independent namespaces, so each is diffed against its OWN declared set.
// `identifierOf` builds the CC composite identifier — the two types ORDER it DIFFERENTLY:
// AWS::Logs::MetricFilter is `["/properties/LogGroupName","/properties/FilterName"]`
// (LogGroupName|FilterName), AWS::Logs::SubscriptionFilter is the REVERSE
// `["/properties/FilterName","/properties/LogGroupName"]` (FilterName|LogGroupName) — using
// the wrong order makes CC GetResource/DeleteResource throw a ValidationException.
function diffLogGroupFilters(
  logGroupName: string,
  resourceType: string,
  declaredFilterNames: string[],
  liveFilters: { name: string; label?: string | undefined }[],
  identifierOf: (filterName: string) => string
): AddedChild[] {
  const declared = new Set(declaredFilterNames);
  const added: AddedChild[] = [];
  for (const f of liveFilters) {
    if (declared.has(f.name)) continue;
    added.push({
      resourceType,
      identifier: identifierOf(f.name),
      label: f.label ?? f.name,
      live: { FilterName: f.name, LogGroupName: logGroupName },
    });
  }
  return added;
}

// Pure diff: declared metric-filter names + live inventory -> the added metric filters.
export interface LogGroupChildInput {
  logGroupName: string;
  declaredFilterNames: string[]; // names of AWS::Logs::MetricFilter declared on this log group
  liveFilters: { name: string; label?: string | undefined }[];
}

export function diffLogGroupChildren(input: LogGroupChildInput): AddedChild[] {
  return diffLogGroupFilters(
    input.logGroupName,
    'AWS::Logs::MetricFilter',
    input.declaredFilterNames,
    input.liveFilters,
    (name) => `${input.logGroupName}|${name}` // CC composite LogGroupName|FilterName
  );
}

// Pure diff: declared subscription-filter names + live inventory -> the added ones.
export interface LogGroupSubscriptionInput {
  logGroupName: string;
  declaredFilterNames: string[]; // names of AWS::Logs::SubscriptionFilter declared on this log group
  liveFilters: { name: string; label?: string | undefined }[];
}

export function diffLogGroupSubscriptionFilters(input: LogGroupSubscriptionInput): AddedChild[] {
  return diffLogGroupFilters(
    input.logGroupName,
    'AWS::Logs::SubscriptionFilter',
    input.declaredFilterNames,
    input.liveFilters,
    // CC composite FilterName|LogGroupName (the REVERSE of MetricFilter — verified live)
    (name) => `${name}|${input.logGroupName}`
  );
}

async function pageMetricFilters(
  client: CloudWatchLogsClient,
  logGroupName: string
): Promise<CwlMetricFilter[]> {
  const out: CwlMetricFilter[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeMetricFiltersCommand({ logGroupName, nextToken: next })
    );
    out.push(...(res.metricFilters ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

async function pageSubscriptionFilters(
  client: CloudWatchLogsClient,
  logGroupName: string
): Promise<CwlSubscriptionFilter[]> {
  const out: CwlSubscriptionFilter[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeSubscriptionFiltersCommand({ logGroupName, nextToken: next })
    );
    out.push(...(res.subscriptionFilters ?? []));
    next = res.nextToken;
  } while (next);
  return out;
}

async function enumerateLogGroupChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const logGroupName = parent.physicalId; // a LogGroup's physical id IS its LogGroupName
  if (!logGroupName) return [];

  // Declared metric filters on THIS log group (Ref/GetAtt LogGroupName already resolved to
  // the physical id by gather). A filter's physical id (Ref) is its FilterName, but prefer a
  // literal declared FilterName when present.
  const declaredFilterNames: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType !== 'AWS::Logs::MetricFilter' ||
      !parentRefMatches(r.declared.LogGroupName, logGroupName)
    ) {
      continue;
    }
    const name = typeof r.declared.FilterName === 'string' ? r.declared.FilterName : r.physicalId;
    if (name) declaredFilterNames.push(name);
  }

  // Declared subscription filters on THIS log group (separate name namespace from metric
  // filters). A SubscriptionFilter's physical id (Ref) is its FilterName.
  const declaredSubscriptionNames: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType !== 'AWS::Logs::SubscriptionFilter' ||
      !parentRefMatches(r.declared.LogGroupName, logGroupName)
    ) {
      continue;
    }
    const name = typeof r.declared.FilterName === 'string' ? r.declared.FilterName : r.physicalId;
    if (name) declaredSubscriptionNames.push(name);
  }

  const client = new CloudWatchLogsClient({ region, ...READ_RETRY });
  const filters = await pageMetricFilters(client, logGroupName);
  const liveFilters = filters
    .filter((f): f is CwlMetricFilter & { filterName: string } => typeof f.filterName === 'string')
    .map((f) => ({ name: f.filterName }));
  const subs = await pageSubscriptionFilters(client, logGroupName);
  const liveSubs = subs
    .filter(
      (f): f is CwlSubscriptionFilter & { filterName: string } => typeof f.filterName === 'string'
    )
    .map((f) => ({ name: f.filterName }));

  return [
    ...diffLogGroupChildren({ logGroupName, declaredFilterNames, liveFilters }),
    ...diffLogGroupSubscriptionFilters({
      logGroupName,
      declaredFilterNames: declaredSubscriptionNames,
      liveFilters: liveSubs,
    }),
  ];
}

// ── Elastic Load Balancing v2 ──────────────────────────────────────────────────
// An `AWS::ElasticLoadBalancingV2::LoadBalancer` owns Listeners, each a separate
// CloudFormation resource. A console / CLI `create-listener` (someone wires a new
// listener onto a load balancer out of band) is invisible to cdk drift / CFn drift
// detection (they only compare template-declared resources). The LoadBalancer's own
// live model does NOT reflect its listeners inline, so there is no double-report to
// suppress. The CC primaryIdentifier for AWS::ElasticLoadBalancingV2::Listener is the
// bare ListenerArn, which CC GetResource / DeleteResource consume.

// Pure diff: declared listener arns + live inventory -> the added listeners.
export interface LoadBalancerChildInput {
  declaredListenerArns: string[]; // physical ids of AWS::ElasticLoadBalancingV2::Listener
  liveListeners: { arn: string; label?: string | undefined }[];
}

export function diffLoadBalancerChildren(input: LoadBalancerChildInput): AddedChild[] {
  const declared = new Set(input.declaredListenerArns);
  const added: AddedChild[] = [];
  for (const l of input.liveListeners) {
    if (declared.has(l.arn)) continue;
    added.push({
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      identifier: l.arn, // ListenerArn IS the CC primaryIdentifier
      label: l.label ?? l.arn,
      live: { ListenerArn: l.arn },
    });
  }
  return added;
}

async function pageListeners(
  client: ElasticLoadBalancingV2Client,
  loadBalancerArn: string
): Promise<Elbv2Listener[]> {
  const out: Elbv2Listener[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new DescribeListenersCommand({ LoadBalancerArn: loadBalancerArn, Marker: marker })
    );
    out.push(...(res.Listeners ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

async function enumerateLoadBalancerChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const lbArn = parent.physicalId; // a LoadBalancer's physical id IS its LoadBalancerArn
  if (!lbArn) return [];

  // Declared listeners of THIS load balancer (Ref/GetAtt LoadBalancerArn already resolved
  // to the physical id by gather). A listener's physical id IS its ListenerArn.
  const declaredListenerArns: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::ElasticLoadBalancingV2::Listener' &&
      parentRefMatches(r.declared.LoadBalancerArn, lbArn) &&
      r.physicalId
    ) {
      declaredListenerArns.push(r.physicalId);
    }
  }

  const client = new ElasticLoadBalancingV2Client({ region, ...READ_RETRY });
  const listeners = await pageListeners(client, lbArn);
  const liveListeners = listeners
    .filter((l): l is Elbv2Listener & { ListenerArn: string } => typeof l.ListenerArn === 'string')
    .map((l) => ({ arn: l.ListenerArn, label: `${l.Protocol}:${l.Port}` }));

  return diffLoadBalancerChildren({ declaredListenerArns, liveListeners });
}

// A Listener (itself a declared template resource, AND enumerated as a child of its
// LoadBalancer) owns ListenerRules, each a separate CloudFormation resource. A console /
// CLI `create-rule` (someone wires a new routing rule onto a listener out of band) is
// invisible to cdk drift / CFn drift detection (they only compare template-declared
// resources). Every listener has an AWS-auto-created DEFAULT rule (`IsDefault`) that is
// not a template resource and is never an out-of-band addition, so it is skipped. The
// Listener's own live model does NOT reflect its rules inline, so there is no
// double-report to suppress. The CC primaryIdentifier for
// AWS::ElasticLoadBalancingV2::ListenerRule is the bare RuleArn, which CC GetResource /
// DeleteResource consume.

// Pure diff: declared rule arns + live inventory -> the added rules.
export interface ListenerChildInput {
  declaredRuleArns: string[]; // physical ids of AWS::ElasticLoadBalancingV2::ListenerRule
  liveRules: { arn: string; label?: string | undefined }[];
}

export function diffListenerChildren(input: ListenerChildInput): AddedChild[] {
  const declared = new Set(input.declaredRuleArns);
  const added: AddedChild[] = [];
  for (const r of input.liveRules) {
    if (declared.has(r.arn)) continue;
    added.push({
      resourceType: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      identifier: r.arn, // RuleArn IS the CC primaryIdentifier
      label: r.label ?? r.arn,
      live: { RuleArn: r.arn },
    });
  }
  return added;
}

async function pageListenerRules(
  client: ElasticLoadBalancingV2Client,
  listenerArn: string
): Promise<Elbv2Rule[]> {
  const out: Elbv2Rule[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new DescribeRulesCommand({ ListenerArn: listenerArn, Marker: marker })
    );
    out.push(...(res.Rules ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

async function enumerateListenerChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const listenerArn = parent.physicalId; // a Listener's physical id IS its ListenerArn
  if (!listenerArn) return [];

  // Declared rules of THIS listener (Ref/GetAtt ListenerArn already resolved to the
  // physical id by gather). A rule's physical id IS its RuleArn.
  const declaredRuleArns: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::ElasticLoadBalancingV2::ListenerRule' &&
      parentRefMatches(r.declared.ListenerArn, listenerArn) &&
      r.physicalId
    ) {
      declaredRuleArns.push(r.physicalId);
    }
  }

  const client = new ElasticLoadBalancingV2Client({ region, ...READ_RETRY });
  const rules = await pageListenerRules(client, listenerArn);
  const liveRules = rules
    // Skip the auto-created default rule: it is created with the listener, not a template
    // resource, and is never an out-of-band addition.
    .filter(
      (r): r is Elbv2Rule & { RuleArn: string } =>
        typeof r.RuleArn === 'string' && r.IsDefault !== true
    )
    .map((r) => ({ arn: r.RuleArn, label: r.Priority ? `priority ${r.Priority}` : r.RuleArn }));

  return diffListenerChildren({ declaredRuleArns, liveRules });
}

// ── EC2 (VPC) ──────────────────────────────────────────────────────────────────
// An `AWS::EC2::VPC` owns Subnets, VPCEndpoints, RouteTables and NetworkAcls, each a
// separate CloudFormation resource. A console / CLI `create-subnet` / `create-vpc-endpoint`
// / `create-route-table` / `create-network-acl` (someone carves a new subnet into a VPC,
// wires a rogue interface/gateway endpoint — an out-of-band data path to S3/DynamoDB or an
// attacker's endpoint service — adds an extra route table, or attaches a quiet
// subnet-level firewall) is invisible to cdk drift / CFn drift detection (they only compare
// template-declared resources). The VPC's own live model does NOT reflect these children
// inline, so there is no double-report to suppress. The CC primaryIdentifier is the bare
// SubnetId (Subnet), the bare Id (VPCEndpoint = VpcEndpointId, NetworkAcl = NetworkAclId),
// and the bare RouteTableId (RouteTable) — all consumed directly by CC GetResource /
// DeleteResource.
//
// FP-safety — a VPC auto-creates built-in defaults that are NOT template resources and must
// never surface as `added`: exactly one MAIN route table (its association `Main: true`) and
// one DEFAULT NetworkAcl (`IsDefault: true`). Those are filtered out here (the `IsDefault` /
// `Main` twin of the ELBv2 default-rule / auto-created-child pattern). VPCEndpoints have NO
// such default class, so no filter is needed for them. (Every non-default, non-declared
// route table / NACL IS a real out-of-band addition.)
//
// SUB-resource additions (#1315). Beyond whole-resource children, the console-level OOB
// additions that re-route or open a VPC are themselves separate CloudFormation resources but
// live INSIDE the parent's describe payload, so they are invisible to whole-resource
// enumeration. Three are diffed here on the VPC parent:
//   - Subnet↔route-table associations (`AWS::EC2::SubnetRouteTableAssociation`): re-pointing a
//     subnet re-routes all its traffic. DescribeRouteTables already returns each table's
//     `Associations[]` (used above only for the `Main` filter); the NON-Main, subnet-bearing
//     ones are diffed against declared AWS::EC2::SubnetRouteTableAssociation. The CC
//     primaryIdentifier is the bare `rtbassoc-…` (RouteTableAssociationId) — a clean
//     DeleteResource revert (disassociate).
//   - IGW attachment (`AWS::EC2::VPCGatewayAttachment`): an internet gateway quietly attached
//     to a "private" VPC. DescribeInternetGateways with an `attachment.vpc-id` filter surfaces
//     it; diffed against declared AWS::EC2::VPCGatewayAttachment on this VPC. The CC
//     primaryIdentifier is the composite `["/properties/AttachmentType","/properties/VpcId"]`
//     whose runtime form is `IGW|<VpcId>` (verified live via CC list-resources) — a clean
//     DeleteResource revert (detach).
//   - Secondary VPC CIDR (`AWS::EC2::VPCCidrBlock`): an OOB `associate-vpc-cidr-block`. The
//     VPC's own `CidrBlockAssociations` / `Ipv6CidrBlockAssociations` carry every secondary
//     block; the PRIMARY IPv4 block (`Vpc.CidrBlock`) is filtered out, and the rest are diffed
//     against declared AWS::EC2::VPCCidrBlock. The CC primaryIdentifier is
//     `["/properties/Id","/properties/VpcId"]` (child-first), runtime form `<AssociationId>|
//     <VpcId>` (#647) — a clean DeleteResource revert (disassociate).
// A fourth sub-resource — NACL entries (`AWS::EC2::NetworkAclEntry`) — is diffed on the
// separate AWS::EC2::NetworkAcl parent enumerator below (a console "allow ALL from
// 0.0.0.0/0" rule punched into a declared NACL reads CLEAN and survives record — a firewall
// hole).

// Pure diff: declared subnet ids + live inventory -> the added subnets.
export interface VpcChildInput {
  declaredSubnetIds: string[]; // physical ids (SubnetIds) of AWS::EC2::Subnet on this VPC
  liveSubnets: { id: string; label?: string | undefined }[];
}

export function diffVpcChildren(input: VpcChildInput): AddedChild[] {
  const declared = new Set(input.declaredSubnetIds);
  const added: AddedChild[] = [];
  for (const s of input.liveSubnets) {
    if (declared.has(s.id)) continue;
    added.push({
      resourceType: 'AWS::EC2::Subnet',
      identifier: s.id, // SubnetId IS the CC primaryIdentifier
      label: s.label ?? s.id,
      live: { SubnetId: s.id },
    });
  }
  return added;
}

// Pure diff: declared VPC-endpoint ids + live inventory -> the added endpoints.
export interface VpcEndpointChildInput {
  declaredEndpointIds: string[]; // physical ids (VpcEndpointIds) of AWS::EC2::VPCEndpoint on this VPC
  liveEndpoints: { id: string; label?: string | undefined }[];
}

export function diffVpcEndpointChildren(input: VpcEndpointChildInput): AddedChild[] {
  const declared = new Set(input.declaredEndpointIds);
  const added: AddedChild[] = [];
  for (const e of input.liveEndpoints) {
    if (declared.has(e.id)) continue;
    added.push({
      resourceType: 'AWS::EC2::VPCEndpoint',
      identifier: e.id, // Id (the VpcEndpointId) IS the CC primaryIdentifier
      label: e.label ?? e.id,
      live: { Id: e.id },
    });
  }
  return added;
}

// Pure diff: declared route-table ids + live inventory (the MAIN table already filtered
// out upstream) -> the added route tables.
export interface VpcRouteTableChildInput {
  declaredRouteTableIds: string[]; // physical ids (RouteTableIds) of AWS::EC2::RouteTable on this VPC
  liveRouteTables: { id: string; label?: string | undefined }[];
}

export function diffVpcRouteTableChildren(input: VpcRouteTableChildInput): AddedChild[] {
  const declared = new Set(input.declaredRouteTableIds);
  const added: AddedChild[] = [];
  for (const rt of input.liveRouteTables) {
    if (declared.has(rt.id)) continue;
    added.push({
      resourceType: 'AWS::EC2::RouteTable',
      identifier: rt.id, // RouteTableId IS the CC primaryIdentifier
      label: rt.label ?? rt.id,
      live: { RouteTableId: rt.id },
    });
  }
  return added;
}

// Pure diff: declared NACL ids + live inventory (the DEFAULT NACL already filtered out
// upstream) -> the added network ACLs.
export interface VpcNaclChildInput {
  declaredNaclIds: string[]; // physical ids (NetworkAclIds) of AWS::EC2::NetworkAcl on this VPC
  liveNacls: { id: string; label?: string | undefined }[];
}

export function diffVpcNaclChildren(input: VpcNaclChildInput): AddedChild[] {
  const declared = new Set(input.declaredNaclIds);
  const added: AddedChild[] = [];
  for (const n of input.liveNacls) {
    if (declared.has(n.id)) continue;
    added.push({
      resourceType: 'AWS::EC2::NetworkAcl',
      identifier: n.id, // Id (the NetworkAclId) IS the CC primaryIdentifier
      label: n.label ?? n.id,
      live: { Id: n.id },
    });
  }
  return added;
}

// Pure diff: declared subnet↔route-table association ids + live inventory (Main + non-subnet
// associations already filtered out upstream) -> the added associations. A
// AWS::EC2::SubnetRouteTableAssociation's CFn physical id (Ref) IS its RouteTableAssociationId
// (`rtbassoc-…`), which is also the CC primaryIdentifier, so declared associations are matched
// by that id. Re-pointing a subnet at a different route table (a fresh associate / a
// replace-route-table-association) yields a NEW RouteTableAssociationId, so an OOB re-point
// surfaces as an `added` association not present in the template.
export interface SubnetRouteTableAssociationChildInput {
  declaredAssociationIds: string[]; // RouteTableAssociationIds of AWS::EC2::SubnetRouteTableAssociation on this VPC
  liveAssociations: {
    id: string;
    subnetId?: string | undefined;
    routeTableId?: string | undefined;
  }[];
}

export function diffSubnetRouteTableAssociationChildren(
  input: SubnetRouteTableAssociationChildInput
): AddedChild[] {
  const declared = new Set(input.declaredAssociationIds);
  const added: AddedChild[] = [];
  for (const a of input.liveAssociations) {
    if (declared.has(a.id)) continue;
    added.push({
      resourceType: 'AWS::EC2::SubnetRouteTableAssociation',
      identifier: a.id, // RouteTableAssociationId IS the CC primaryIdentifier (rtbassoc-…)
      label: a.subnetId ? `${a.subnetId} -> ${a.routeTableId ?? '?'}` : a.id,
      live: { Id: a.id, SubnetId: a.subnetId, RouteTableId: a.routeTableId },
    });
  }
  return added;
}

// Pure diff: declared IGW-attachment vpc ids + live attachment inventory -> the added
// attachments. A AWS::EC2::VPCGatewayAttachment attaching an internet gateway is keyed by
// its VpcId (a VPC has at most one IGW attachment), so a declared attachment on THIS VPC
// suppresses the live one; an OOB `attach-internet-gateway` on an unattached VPC surfaces.
// The CC primaryIdentifier is the composite [AttachmentType, VpcId], runtime `IGW|<VpcId>`.
export interface VpcGatewayAttachmentChildInput {
  vpcId: string;
  hasDeclaredIgwAttachment: boolean; // an AWS::EC2::VPCGatewayAttachment (InternetGatewayId set) on THIS VPC
  liveInternetGatewayId?: string | undefined; // the IGW live-attached to THIS VPC, if any
}

export function diffVpcGatewayAttachmentChildren(
  input: VpcGatewayAttachmentChildInput
): AddedChild[] {
  const { vpcId, hasDeclaredIgwAttachment, liveInternetGatewayId } = input;
  if (!liveInternetGatewayId || hasDeclaredIgwAttachment) return [];
  return [
    {
      resourceType: 'AWS::EC2::VPCGatewayAttachment',
      identifier: `IGW|${vpcId}`, // CC composite AttachmentType|VpcId (runtime form IGW|<VpcId>)
      label: `${liveInternetGatewayId} -> ${vpcId}`,
      live: { AttachmentType: 'IGW', InternetGatewayId: liveInternetGatewayId, VpcId: vpcId },
    },
  ];
}

// Pure diff: declared secondary-CIDR blocks + live secondary-block inventory (the PRIMARY
// IPv4 block already filtered out upstream) -> the added CIDR associations. A
// AWS::EC2::VPCCidrBlock is matched by its CIDR block value (the CFn physical id is the
// opaque AssociationId, so the human-declarable CIDR is the stable identity handle). The CC
// primaryIdentifier is [Id, VpcId] (child-first), runtime `<AssociationId>|<VpcId>` (#647).
export interface VpcCidrBlockChildInput {
  vpcId: string;
  declaredCidrs: string[]; // CidrBlock / Ipv6CidrBlock values of AWS::EC2::VPCCidrBlock on this VPC
  liveCidrBlocks: { associationId: string; cidr: string }[];
}

export function diffVpcCidrBlockChildren(input: VpcCidrBlockChildInput): AddedChild[] {
  const declared = new Set(input.declaredCidrs);
  const added: AddedChild[] = [];
  for (const b of input.liveCidrBlocks) {
    if (declared.has(b.cidr)) continue;
    added.push({
      resourceType: 'AWS::EC2::VPCCidrBlock',
      identifier: `${b.associationId}|${input.vpcId}`, // CC composite Id|VpcId (child-first, #647)
      label: b.cidr,
      live: { Id: b.associationId, VpcId: input.vpcId, CidrBlock: b.cidr },
    });
  }
  return added;
}

async function pageSubnets(client: EC2Client, vpcId: string): Promise<Ec2Subnet[]> {
  const out: Ec2Subnet[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeSubnetsCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        NextToken: next,
      })
    );
    out.push(...(res.Subnets ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function pageVpcEndpoints(client: EC2Client, vpcId: string): Promise<Ec2VpcEndpoint[]> {
  const out: Ec2VpcEndpoint[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeVpcEndpointsCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        NextToken: next,
      })
    );
    out.push(...(res.VpcEndpoints ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function pageVpcRouteTables(client: EC2Client, vpcId: string): Promise<Ec2RouteTable[]> {
  const out: Ec2RouteTable[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeRouteTablesCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        NextToken: next,
      })
    );
    out.push(...(res.RouteTables ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function pageNetworkAcls(client: EC2Client, vpcId: string): Promise<Ec2NetworkAcl[]> {
  const out: Ec2NetworkAcl[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeNetworkAclsCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        NextToken: next,
      })
    );
    out.push(...(res.NetworkAcls ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function pageInternetGateways(
  client: EC2Client,
  vpcId: string
): Promise<Ec2InternetGateway[]> {
  const out: Ec2InternetGateway[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new DescribeInternetGatewaysCommand({
        Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }],
        NextToken: next,
      })
    );
    out.push(...(res.InternetGateways ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function describeVpc(client: EC2Client, vpcId: string): Promise<Ec2Vpc | undefined> {
  const res = await client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
  return res.Vpcs?.[0];
}

export async function enumerateVpcChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const vpcId = parent.physicalId; // a VPC's physical id IS its VpcId
  if (!vpcId) return [];

  // Declared subnets + VPC endpoints + route tables + NACLs of THIS VPC (Ref/GetAtt VpcId
  // already resolved to the physical id by gather). Each child's physical id IS its bare
  // resource id (SubnetId / VpcEndpointId / RouteTableId / NetworkAclId).
  const declaredSubnetIds: string[] = [];
  const declaredEndpointIds: string[] = [];
  const declaredRouteTableIds: string[] = [];
  const declaredNaclIds: string[] = [];
  for (const r of desired.resources) {
    if (!parentRefMatches(r.declared.VpcId, vpcId) || !r.physicalId) continue;
    if (r.resourceType === 'AWS::EC2::Subnet') {
      declaredSubnetIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::EC2::VPCEndpoint') {
      declaredEndpointIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::EC2::RouteTable') {
      declaredRouteTableIds.push(r.physicalId);
    } else if (r.resourceType === 'AWS::EC2::NetworkAcl') {
      declaredNaclIds.push(r.physicalId);
    }
  }

  // Declared sub-resources of THIS VPC (#1315): subnet↔route-table associations (keyed by
  // RouteTableAssociationId = the Ref/physical id), IGW attachments (an
  // AWS::EC2::VPCGatewayAttachment with an InternetGatewayId on this VPC), and secondary CIDR
  // blocks (an AWS::EC2::VPCCidrBlock, matched by its declared CidrBlock / Ipv6CidrBlock).
  const declaredAssociationIds: string[] = [];
  let hasDeclaredIgwAttachment = false;
  const declaredCidrs: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType === 'AWS::EC2::SubnetRouteTableAssociation') {
      // A subnet↔route-table association references its VPC only INDIRECTLY (via SubnetId /
      // RouteTableId), so it cannot be scoped by VpcId here; the live-association diff below
      // is already scoped to THIS VPC's tables, so an association id declared on ANOTHER VPC
      // simply never matches a live id in this set (no false suppression). Match by the
      // RouteTableAssociationId = the resource's Ref / physical id.
      if (r.physicalId) declaredAssociationIds.push(r.physicalId);
    } else if (
      r.resourceType === 'AWS::EC2::VPCGatewayAttachment' &&
      parentRefMatches(r.declared.VpcId, vpcId) &&
      r.declared.InternetGatewayId != null
    ) {
      hasDeclaredIgwAttachment = true;
    } else if (
      r.resourceType === 'AWS::EC2::VPCCidrBlock' &&
      parentRefMatches(r.declared.VpcId, vpcId)
    ) {
      const cidr = r.declared.CidrBlock ?? r.declared.Ipv6CidrBlock;
      if (typeof cidr === 'string') declaredCidrs.push(cidr);
    }
  }

  const client = new EC2Client({ region, ...READ_RETRY });
  const subnets = await pageSubnets(client, vpcId);
  const liveSubnets = subnets
    .filter((s): s is Ec2Subnet & { SubnetId: string } => typeof s.SubnetId === 'string')
    .map((s) => ({ id: s.SubnetId, label: s.CidrBlock ? `${s.CidrBlock}` : s.SubnetId }));

  const endpoints = await pageVpcEndpoints(client, vpcId);
  const liveEndpoints = endpoints
    .filter(
      (e): e is Ec2VpcEndpoint & { VpcEndpointId: string } => typeof e.VpcEndpointId === 'string'
    )
    .map((e) => ({ id: e.VpcEndpointId, label: e.ServiceName ?? e.VpcEndpointId }));

  // Drop the MAIN route table (AWS auto-creates one per VPC; its association carries
  // `Main: true`) — a built-in default, never an out-of-band addition.
  const routeTables = await pageVpcRouteTables(client, vpcId);
  const liveRouteTables = routeTables
    .filter(
      (rt): rt is Ec2RouteTable & { RouteTableId: string } => typeof rt.RouteTableId === 'string'
    )
    .filter((rt) => !(rt.Associations ?? []).some((a) => a.Main === true))
    .map((rt) => ({ id: rt.RouteTableId, label: rt.RouteTableId }));

  // Subnet↔route-table associations (#1315): the same DescribeRouteTables payload carries each
  // table's `Associations[]`. Keep only the EXPLICIT subnet associations — drop the MAIN
  // association (`Main: true`, the implicit default) and any non-subnet (gateway) association,
  // both of which have no `AWS::EC2::SubnetRouteTableAssociation` template resource. A live
  // association whose RouteTableAssociationId is not declared is an out-of-band re-point.
  const liveAssociations = routeTables
    .flatMap((rt) => rt.Associations ?? [])
    .filter(
      (a): a is Ec2RouteTableAssociation & { RouteTableAssociationId: string } =>
        typeof a.RouteTableAssociationId === 'string' &&
        a.Main !== true &&
        typeof a.SubnetId === 'string'
    )
    .map((a) => ({
      id: a.RouteTableAssociationId,
      subnetId: a.SubnetId,
      routeTableId: a.RouteTableId,
    }));

  // Drop the DEFAULT NACL (AWS auto-creates one per VPC, `IsDefault: true`) — a built-in
  // default, never an out-of-band addition.
  const nacls = await pageNetworkAcls(client, vpcId);
  const liveNacls = nacls
    .filter(
      (n): n is Ec2NetworkAcl & { NetworkAclId: string } => typeof n.NetworkAclId === 'string'
    )
    .filter((n) => n.IsDefault !== true)
    .map((n) => ({ id: n.NetworkAclId, label: n.NetworkAclId }));

  // IGW attachment (#1315): DescribeInternetGateways filtered to `attachment.vpc-id` returns
  // the internet gateway currently attached to THIS VPC (at most one). If the template does
  // not declare an AWS::EC2::VPCGatewayAttachment for it, the attachment is out of band.
  const internetGateways = await pageInternetGateways(client, vpcId);
  const liveInternetGatewayId = internetGateways.find(
    (igw): igw is Ec2InternetGateway & { InternetGatewayId: string } =>
      typeof igw.InternetGatewayId === 'string'
  )?.InternetGatewayId;

  // Secondary VPC CIDR (#1315): DescribeVpcs returns the VPC's CidrBlockAssociations +
  // Ipv6CidrBlockAssociations. Drop the PRIMARY IPv4 block (`Vpc.CidrBlock`, created with the
  // VPC and never a template resource); every other associated block is a secondary CIDR
  // corresponding to a declarable AWS::EC2::VPCCidrBlock. An association whose CIDR value is
  // not declared is an out-of-band `associate-vpc-cidr-block`.
  const vpc = await describeVpc(client, vpcId);
  const primaryCidr = typeof vpc?.CidrBlock === 'string' ? vpc.CidrBlock : undefined;
  const liveCidrBlocks: { associationId: string; cidr: string }[] = [];
  for (const b of vpc?.CidrBlockAssociationSet ?? []) {
    if (typeof b.AssociationId !== 'string' || typeof b.CidrBlock !== 'string') continue;
    if (b.CidrBlock === primaryCidr) continue; // the primary IPv4 block is not a template resource
    liveCidrBlocks.push({ associationId: b.AssociationId, cidr: b.CidrBlock });
  }
  for (const b of vpc?.Ipv6CidrBlockAssociationSet ?? []) {
    if (typeof b.AssociationId !== 'string' || typeof b.Ipv6CidrBlock !== 'string') continue;
    liveCidrBlocks.push({ associationId: b.AssociationId, cidr: b.Ipv6CidrBlock });
  }

  return [
    ...diffVpcChildren({ declaredSubnetIds, liveSubnets }),
    ...diffVpcEndpointChildren({ declaredEndpointIds, liveEndpoints }),
    ...diffVpcRouteTableChildren({ declaredRouteTableIds, liveRouteTables }),
    ...diffVpcNaclChildren({ declaredNaclIds, liveNacls }),
    ...diffSubnetRouteTableAssociationChildren({ declaredAssociationIds, liveAssociations }),
    ...diffVpcGatewayAttachmentChildren({
      vpcId,
      hasDeclaredIgwAttachment,
      liveInternetGatewayId,
    }),
    ...diffVpcCidrBlockChildren({ vpcId, declaredCidrs, liveCidrBlocks }),
  ];
}

// ── EC2 (NetworkAcl) ──────────────────────────────────────────────────────────
// An `AWS::EC2::NetworkAcl` owns Entries (NACL rules), each a separate CloudFormation
// resource (`AWS::EC2::NetworkAclEntry`). The CC `AWS::EC2::NetworkAcl` model is only
// Id/VpcId/Tags — it does NOT reflect its entries inline — so a console / CLI
// `create-network-acl-entry` (someone punches an "allow ALL from 0.0.0.0/0" rule into a
// DECLARED NACL out of band, a firewall hole) reads CLEAN and survives `record`, invisible
// to cdk drift / CFn drift detection (they only compare template-declared resources). Read
// the parent NACL's `Entries[]` via EC2 DescribeNetworkAcls and diff them against the
// declared AWS::EC2::NetworkAclEntry resources on this NACL.
//
// FP-safety: every NACL AWS-auto-creates two DEFAULT deny-all catch-all rules (RuleNumber
// 32767, one ingress + one egress; the IPv6 default uses the same 32767 with an
// Ipv6CidrBlock ::/0) that are NOT template resources — filtered out here (the `32767` twin
// of the Main route-table / IsDefault NACL default-child pattern). A NACL entry's identity
// within its NACL is the (RuleNumber, Egress) pair (a NACL holds at most one entry per
// pair). The CC primaryIdentifier is the opaque readOnly `Id` (a generated form CC's
// UnsupportedAction GetResource/DeleteResource cannot consume — the same CC gap that made
// readEc2NetworkAclEntry an SDK override), so the `added` `identifier` is the
// `NetworkAclId|RuleNumber|Egress` composite: this SURFACES the rule (the primary value —
// visibility + record / ignore) even though a CC DeleteResource revert is not available for
// this type.

// AWS auto-creates the catch-all DEFAULT deny rule (ingress + egress) at RuleNumber 32767 on
// every NACL; it is not a template resource and must never surface as `added` (#1315).
const NACL_DEFAULT_RULE_NUMBER = 32767;

// Pure diff: declared NACL-entry keys + live entry inventory (the 32767 default rules already
// filtered out upstream) -> the added entries. A NACL entry is matched by its
// (RuleNumber, Egress) identity within the NACL.
export interface NetworkAclEntryChildInput {
  naclId: string;
  declaredEntryKeys: string[]; // `${RuleNumber}|${Egress}` for each declared AWS::EC2::NetworkAclEntry on this NACL
  liveEntries: {
    ruleNumber: number;
    egress: boolean;
    cidr?: string | undefined; // CidrBlock / Ipv6CidrBlock — display only
    ruleAction?: string | undefined; // allow / deny — display only
  }[];
}

export function diffNetworkAclEntryChildren(input: NetworkAclEntryChildInput): AddedChild[] {
  const { naclId, declaredEntryKeys, liveEntries } = input;
  const declared = new Set(declaredEntryKeys);
  const added: AddedChild[] = [];
  for (const e of liveEntries) {
    const key = `${e.ruleNumber}|${e.egress}`;
    if (declared.has(key)) continue;
    const dir = e.egress ? 'egress' : 'ingress';
    const detail = [e.ruleAction, e.cidr].filter((v) => v != null).join(' ');
    added.push({
      resourceType: 'AWS::EC2::NetworkAclEntry',
      // CC primaryIdentifier is the opaque readOnly `Id` (CC has no read/delete handler for
      // this type), so use the NetworkAclId|RuleNumber|Egress identity composite.
      identifier: `${naclId}|${e.ruleNumber}|${e.egress}`,
      label: `#${e.ruleNumber} ${dir}${detail ? ` ${detail}` : ''}`,
      live: {
        NetworkAclId: naclId,
        RuleNumber: e.ruleNumber,
        Egress: e.egress,
        ...(e.ruleAction != null ? { RuleAction: e.ruleAction } : {}),
        ...(e.cidr != null ? { CidrBlock: e.cidr } : {}),
      },
    });
  }
  return added;
}

async function describeNetworkAcl(
  client: EC2Client,
  naclId: string
): Promise<Ec2NetworkAcl | undefined> {
  const res = await client.send(new DescribeNetworkAclsCommand({ NetworkAclIds: [naclId] }));
  return res.NetworkAcls?.[0];
}

export async function enumerateNetworkAclChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const naclId = parent.physicalId; // a NetworkAcl's physical id IS its NetworkAclId
  if (!naclId) return [];

  // Declared NACL entries on THIS NACL (Ref/GetAtt NetworkAclId already resolved to the
  // physical id by gather). A NACL entry's CFn physical id is an opaque generated id, so
  // MATCH declared entries by their (RuleNumber, Egress) identity within the NACL.
  const declaredEntryKeys: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType !== 'AWS::EC2::NetworkAclEntry' ||
      !parentRefMatches(r.declared.NetworkAclId, naclId)
    ) {
      continue;
    }
    const ruleNumber = r.declared.RuleNumber;
    // Egress defaults to false when the template omits it (an ingress rule).
    const egress = r.declared.Egress === true;
    if (typeof ruleNumber === 'number') declaredEntryKeys.push(`${ruleNumber}|${egress}`);
  }

  const client = new EC2Client({ region, ...READ_RETRY });
  const nacl = await describeNetworkAcl(client, naclId);
  const liveEntries = (nacl?.Entries ?? [])
    .filter(
      (e): e is Ec2NetworkAclEntry & { RuleNumber: number; Egress: boolean } =>
        typeof e.RuleNumber === 'number' && typeof e.Egress === 'boolean'
    )
    // Drop the AWS-auto-created catch-all default rules (RuleNumber 32767, ingress + egress,
    // IPv4 + IPv6) — built-in defaults, never out-of-band additions.
    .filter((e) => e.RuleNumber !== NACL_DEFAULT_RULE_NUMBER)
    .map((e) => ({
      ruleNumber: e.RuleNumber,
      egress: e.Egress,
      cidr: e.CidrBlock ?? e.Ipv6CidrBlock,
      ruleAction: e.RuleAction,
    }));

  return diffNetworkAclEntryChildren({ naclId, declaredEntryKeys, liveEntries });
}

// ── EC2 (RouteTable) ────────────────────────────────────────────────────────────
// An `AWS::EC2::RouteTable` owns Routes, each a separate CloudFormation resource. A
// console / CLI `create-route` (someone adds a route to a route table out of band) is
// invisible to cdk drift / CFn drift detection (they only compare template-declared
// resources). The RouteTable's own live model does NOT reflect its routes inline (it
// carries only RouteTableId / VpcId / Tags), so there is no double-report to suppress.
// Non-declarable routes are skipped by `isEnumerableRoute`: the auto-created VPC-CIDR
// LOCAL route (`Origin CreateRouteTable` / `GatewayId local`) and VGW-PROPAGATED routes
// (`Origin EnableVgwRoutePropagation` — BGP/propagated, not declarable `AWS::EC2::Route`
// resources). IPv4 (`DestinationCidrBlock`), IPv6 (`DestinationIpv6CidrBlock`), and managed
// prefix-list (`DestinationPrefixListId`) routes are ALL handled (#1081) — each is a
// user-declarable `AWS::EC2::Route` and CC's readOnly `CidrBlock` identifier component holds
// whichever one the route carries (see routeDestination). The CC primaryIdentifier for
// AWS::EC2::Route is the composite `["/properties/RouteTableId","/properties/CidrBlock"]`, so
// the `identifier` is the composite `RouteTableId|<destination>` (RouteTableId first) — that
// is what CC GetResource / DeleteResource consume.

// Pure diff: declared cidrs + live inventory -> the added routes.
export interface RouteTableChildInput {
  routeTableId: string;
  // The destination of each AWS::EC2::Route declared on this table — IPv4 DestinationCidrBlock,
  // IPv6 DestinationIpv6CidrBlock, or DestinationPrefixListId (whichever the route sets). The
  // `cidr` name is historical; the value is the route's identity handle, any destination shape.
  declaredCidrs: string[];
  liveRoutes: { cidr: string }[];
  // Fail-safe (#1082): at least one declared route on this table has an UNRESOLVED
  // DestinationCidrBlock (a `{{resolve:ssm:...}}` dynamic ref, a degraded Fn::ImportValue,
  // or a no-default NoEcho Ref → the UNRESOLVED symbol). The route's identity is matched
  // ONLY through its DestinationCidrBlock (the CFn physical id is a generated token), so an
  // UNRESOLVED cidr cannot be matched to any live route. Reporting a live route as `added`
  // then risks a destructive `revert --remove-unrecorded` DeleteResource against a route the
  // template DECLARES. When true, suppress `added` for THIS table's routes entirely.
  hasUnresolvedDeclaredRoute?: boolean;
}

export function diffRouteTableChildren(input: RouteTableChildInput): AddedChild[] {
  const { routeTableId, declaredCidrs, liveRoutes, hasUnresolvedDeclaredRoute } = input;
  // A declared route with an UNRESOLVED DestinationCidrBlock could be ANY of the live
  // routes — we can't tell which — so we cannot safely call any live route `added`.
  if (hasUnresolvedDeclaredRoute) return [];
  const declared = new Set(declaredCidrs);
  const added: AddedChild[] = [];
  for (const route of liveRoutes) {
    if (declared.has(route.cidr)) continue;
    added.push({
      resourceType: 'AWS::EC2::Route',
      identifier: `${routeTableId}|${route.cidr}`, // CC composite RouteTableId|CidrBlock
      label: route.cidr,
      live: { RouteTableId: routeTableId, CidrBlock: route.cidr },
    });
  }
  return added;
}

async function describeRouteTable(client: EC2Client, routeTableId: string): Promise<Ec2Route[]> {
  const res = await client.send(new DescribeRouteTablesCommand({ RouteTableIds: [routeTableId] }));
  return res.RouteTables?.[0]?.Routes ?? [];
}

// The single destination of an `AWS::EC2::Route` — exactly ONE of DestinationCidrBlock
// (IPv4), DestinationIpv6CidrBlock (IPv6), or DestinationPrefixListId (managed prefix list)
// is set per route. CC's AWS::EC2::Route primaryIdentifier is `RouteTableId|CidrBlock`, and
// its readOnly `CidrBlock` holds whichever one of the three the route carries — so the same
// value is both the route's identity within the table AND the CC identifier component,
// regardless of destination shape. Returns undefined for a route with no such destination
// (a propagated/local route). Pure + exported for unit tests. (#1081)
export function routeDestination(route: Ec2Route): string | undefined {
  if (typeof route.DestinationCidrBlock === 'string') return route.DestinationCidrBlock;
  if (typeof route.DestinationIpv6CidrBlock === 'string') return route.DestinationIpv6CidrBlock;
  if (typeof route.DestinationPrefixListId === 'string') return route.DestinationPrefixListId;
  return undefined;
}

// A live route is an enumerable out-of-band `AWS::EC2::Route` only if it is one a user
// could have declared. EXCLUDED:
//   - the auto-created VPC-CIDR LOCAL route (Origin CreateRouteTable / GatewayId local);
//   - a route with no user-declarable destination (routeDestination undefined);
//   - a route inserted by VGW route PROPAGATION (Origin EnableVgwRoutePropagation): these
//     are BGP/propagated, not declarable `AWS::EC2::Route` resources, and AWS re-creates
//     them — flagging one as `added` is a false positive, and a `revert` DeleteResource
//     would either churn (AWS re-propagates) or fail.
//   - a route MATERIALIZED by a declared Gateway VPC endpoint (`AWS::EC2::VPCEndpoint`,
//     VpcEndpointType Gateway — the S3/DynamoDB endpoint, CDK `vpc.addGatewayEndpoint`):
//     the endpoint writes a `DestinationPrefixListId: pl-…` + `GatewayId: vpce-…` route into
//     every table in its RouteTableIds. That route is NOT a declarable standalone
//     `AWS::EC2::Route` (the endpoint owns it), so flagging it `added` is a false positive on
//     every clean check, and a `revert` DeleteResource would SEVER S3/DynamoDB connectivity
//     for the private subnets (the endpoint then re-adds it → churn). A genuinely rogue
//     gateway endpoint is itself surfaced by the VPC enumerator (#1045), so nothing is lost.
//     Detected by the exact managed shape: a prefix-list destination AND a `vpce-` GatewayId.
//     GWLB (Gateway Load Balancer) endpoint routes use a CIDR destination (not a prefix
//     list), so they remain enumerable.
// IPv6 (`DestinationIpv6CidrBlock`, e.g. a rogue `::/0` on a dual-stack VPC) and managed
// prefix-list (`DestinationPrefixListId`) routes are otherwise INCLUDED — they are
// user-declarable `AWS::EC2::Route` shapes and a real traffic-redirection vector (#1081).
// Pure + exported.
export function isEnumerableRoute(route: Ec2Route): boolean {
  const isGatewayEndpointManaged =
    typeof route.DestinationPrefixListId === 'string' &&
    typeof route.GatewayId === 'string' &&
    route.GatewayId.startsWith('vpce-');
  return (
    routeDestination(route) !== undefined &&
    route.Origin !== 'CreateRouteTable' &&
    route.Origin !== 'EnableVgwRoutePropagation' &&
    route.GatewayId !== 'local' &&
    !isGatewayEndpointManaged
  );
}

async function enumerateRouteTableChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const routeTableId = parent.physicalId; // a RouteTable's physical id IS its RouteTableId
  if (!routeTableId) return [];

  // Declared routes on THIS route table (Ref/GetAtt RouteTableId already resolved to the
  // physical id by gather). A route's CFn physical id is a generated token, so MATCH
  // declared routes by their destination (the route's identity within the table) — IPv4
  // DestinationCidrBlock, IPv6 DestinationIpv6CidrBlock, or DestinationPrefixListId, exactly
  // one of which a route declares. Collecting all three keeps the declared side aligned with
  // the live side (which now enumerates all three), so a declared v6/prefix route is not
  // false-flagged `added` (#1081).
  const declaredCidrs: string[] = [];
  let hasUnresolvedDeclaredRoute = false;
  for (const r of desired.resources) {
    if (
      r.resourceType !== 'AWS::EC2::Route' ||
      !parentRefMatches(r.declared.RouteTableId, routeTableId)
    ) {
      continue;
    }
    const cidr =
      r.declared.DestinationCidrBlock ??
      r.declared.DestinationIpv6CidrBlock ??
      r.declared.DestinationPrefixListId;
    if (typeof cidr === 'string') {
      declaredCidrs.push(cidr);
    } else if (cidr === UNRESOLVED || hasUnresolved(cidr)) {
      // Fail-safe (#1082): an UNRESOLVED DestinationCidrBlock (dynamic ref / degraded
      // ImportValue / no-default NoEcho Ref) is this route's ONLY identity handle, so its
      // live counterpart cannot be matched. Suppress `added` for this table's routes rather
      // than offer a destructive delete of a route the template declares. Mirrors the
      // parentRefMatches / #962 fail-safe, applied to the child IDENTITY property.
      hasUnresolvedDeclaredRoute = true;
    }
  }

  const client = new EC2Client({ region, ...READ_RETRY });
  const routes = await describeRouteTable(client, routeTableId);
  const liveRoutes = routes
    .filter(isEnumerableRoute)
    // routeDestination is defined for every route isEnumerableRoute kept.
    .map((route) => ({ cidr: routeDestination(route) as string }));

  return diffRouteTableChildren({
    routeTableId,
    declaredCidrs,
    liveRoutes,
    hasUnresolvedDeclaredRoute,
  });
}

// ── ECS ──────────────────────────────────────────────────────────────────────
// An `AWS::ECS::Cluster` owns Services, each a separate CloudFormation resource. A
// console / CLI `create-service` (someone launches a new service onto a cluster out of
// band) is invisible to cdk drift / CFn drift detection (they only compare
// template-declared resources). The Cluster's own live model does NOT reflect its
// services inline, so there is no double-report to suppress. The CC primaryIdentifier for
// AWS::ECS::Service is the composite `["/properties/ServiceArn","/properties/Cluster"]`,
// so the `identifier` is the composite `ServiceArn|Cluster` (ServiceArn first) — that is
// what CC GetResource / DeleteResource consume.

// Pure diff: declared service arns + live inventory -> the added services.
export interface EcsClusterChildInput {
  cluster: string; // the cluster name (the Cluster half of the composite identifier)
  declaredServiceArns: string[]; // physical ids (ServiceArns) of AWS::ECS::Service on this cluster
  liveServices: { arn: string; label?: string | undefined }[];
}

export function diffEcsClusterChildren(input: EcsClusterChildInput): AddedChild[] {
  const { cluster, declaredServiceArns, liveServices } = input;
  const declared = new Set(declaredServiceArns);
  const added: AddedChild[] = [];
  for (const svc of liveServices) {
    if (declared.has(svc.arn)) continue;
    added.push({
      resourceType: 'AWS::ECS::Service',
      identifier: `${svc.arn}|${cluster}`, // CC composite ServiceArn|Cluster
      label: svc.label ?? svc.arn,
      live: { ServiceArn: svc.arn },
    });
  }
  return added;
}

async function pageServices(client: ECSClient, cluster: string): Promise<string[]> {
  const out: string[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(new ListServicesCommand({ cluster, nextToken: next }));
    for (const arn of res.serviceArns ?? []) {
      if (typeof arn === 'string') out.push(arn);
    }
    next = res.nextToken;
  } while (next);
  return out;
}

async function enumerateEcsClusterChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const cluster = parent.physicalId; // a Cluster's physical id IS its cluster name
  if (!cluster) return [];

  // The cluster ARN, for matching a declared service whose `Cluster` was resolved to the
  // ARN form (gather may resolve Ref/GetAtt to either the name or the ARN).
  const clusterArnRaw = desired.ctx.liveAttrs[parent.logicalId]?.Arn;
  const clusterArn = typeof clusterArnRaw === 'string' ? clusterArnRaw : undefined;

  // Declared services of THIS cluster (Ref/GetAtt Cluster already resolved by gather). A
  // service's physical id (Ref) IS its ServiceArn. Match services to this cluster by the
  // declared `Cluster` resolving to either the cluster name or its ARN.
  const declaredServiceArns: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::ECS::Service' || !r.physicalId) continue;
    const decl = r.declared.Cluster;
    if (parentRefMatches(decl, cluster, clusterArn)) {
      declaredServiceArns.push(r.physicalId);
    }
  }

  const client = new ECSClient({ region, ...READ_RETRY });
  const arns = await pageServices(client, cluster);
  const liveServices = arns.map((arn) => ({ arn, label: arn.split('/').pop() }));

  return diffEcsClusterChildren({ cluster, declaredServiceArns, liveServices });
}

// ── KMS ──────────────────────────────────────────────────────────────────────
// An `AWS::KMS::Key` owns Aliases, each a separate CloudFormation resource. A
// console / CLI `create-alias` (someone points a new alias at a key out of band) is
// invisible to cdk drift / CFn drift detection (they only compare template-declared
// resources). The Key's own live model does NOT reflect its aliases inline, so there
// is no double-report to suppress. The CC primaryIdentifier for AWS::KMS::Alias is the
// bare AliasName (e.g. `alias/foo`), which CC GetResource / DeleteResource consume.

// Pure diff: declared alias names + live inventory -> the added aliases.
export interface KmsKeyChildInput {
  declaredAliasNames: string[]; // AliasNames of AWS::KMS::Alias declared on this key
  liveAliases: { name: string; label?: string | undefined }[];
}

export function diffKmsKeyChildren(input: KmsKeyChildInput): AddedChild[] {
  const declared = new Set(input.declaredAliasNames);
  const added: AddedChild[] = [];
  for (const alias of input.liveAliases) {
    if (declared.has(alias.name)) continue;
    added.push({
      resourceType: 'AWS::KMS::Alias',
      identifier: alias.name, // AliasName IS the CC primaryIdentifier
      label: alias.label ?? alias.name,
      live: { AliasName: alias.name },
    });
  }
  return added;
}

async function pageAliases(client: KMSClient, keyId: string): Promise<AliasListEntry[]> {
  const out: AliasListEntry[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(new ListAliasesCommand({ KeyId: keyId, Marker: marker }));
    out.push(...(res.Aliases ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

async function enumerateKmsKeyChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const keyId = parent.physicalId; // a Key's physical id IS its KeyId (UUID)
  if (!keyId) return [];

  // Declared aliases targeting THIS key. An alias's TargetKeyId (resolved by gather) is
  // either the bare KeyId or the key ARN; tolerate both. An alias's CFn physical id (Ref)
  // IS its AliasName, so fall back to the physical id when AliasName is not a literal.
  const keyArnRaw = desired.ctx.liveAttrs[parent.logicalId]?.Arn;
  const keyArn = typeof keyArnRaw === 'string' ? keyArnRaw : undefined;
  const declaredAliasNames: string[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::KMS::Alias') continue;
    const target = r.declared.TargetKeyId;
    if (!parentRefMatches(target, keyId, keyArn)) continue;
    const name = typeof r.declared.AliasName === 'string' ? r.declared.AliasName : r.physicalId;
    if (name) declaredAliasNames.push(name);
  }

  const client = new KMSClient({ region, ...READ_RETRY });
  const aliases = await pageAliases(client, keyId);
  const liveAliases = aliases
    .filter((a): a is AliasListEntry & { AliasName: string } => typeof a.AliasName === 'string')
    .map((a) => ({ name: a.AliasName }));

  return diffKmsKeyChildren({ declaredAliasNames, liveAliases });
}

// ── AppConfig ──────────────────────────────────────────────────────────────────
// An `AWS::AppConfig::Application` owns Environments AND ConfigurationProfiles, each a
// separate CloudFormation resource. A console / CLI `create-environment` /
// `create-configuration-profile` (someone adds a new environment or configuration profile
// to an application out of band) is invisible to cdk drift / CFn drift detection (they only
// compare template-declared resources). The Application's own live model does NOT reflect
// its environments or profiles inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::AppConfig::Environment is the composite
// `["/properties/ApplicationId","/properties/EnvironmentId"]` and for
// AWS::AppConfig::ConfigurationProfile the composite
// `["/properties/ApplicationId","/properties/ConfigurationProfileId"]`, so the `identifier`
// is the composite `ApplicationId|EnvironmentId` / `ApplicationId|ConfigurationProfileId`
// (ApplicationId first) — that is what CC GetResource / DeleteResource consume.

// Pure diff: declared environment ids + live inventory -> the added environments.
export interface AppConfigApplicationChildInput {
  applicationId: string;
  declaredEnvironmentIds: string[]; // physical ids (EnvironmentIds) of AWS::AppConfig::Environment
  liveEnvironments: { id: string; label?: string | undefined }[];
}

export function diffAppConfigApplicationChildren(
  input: AppConfigApplicationChildInput
): AddedChild[] {
  const { applicationId, declaredEnvironmentIds, liveEnvironments } = input;
  const declared = new Set(declaredEnvironmentIds);
  const added: AddedChild[] = [];
  for (const e of liveEnvironments) {
    if (declared.has(e.id)) continue;
    added.push({
      resourceType: 'AWS::AppConfig::Environment',
      identifier: `${applicationId}|${e.id}`, // CC composite ApplicationId|EnvironmentId
      label: e.label ?? e.id,
      live: { EnvironmentId: e.id, ApplicationId: applicationId },
    });
  }
  return added;
}

async function pageAppConfigEnvironments(
  client: AppConfigClient,
  applicationId: string
): Promise<AppConfigEnvironment[]> {
  const out: AppConfigEnvironment[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListEnvironmentsCommand({ ApplicationId: applicationId, NextToken: next })
    );
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

// Pure diff: declared configuration-profile ids + live inventory -> the added profiles.
export interface AppConfigProfilesInput {
  applicationId: string;
  declaredProfileIds: string[]; // physical ids (ConfigurationProfileIds) of the declared profiles
  liveProfiles: { id: string; label?: string | undefined }[];
}

export function diffAppConfigProfiles(input: AppConfigProfilesInput): AddedChild[] {
  const { applicationId, declaredProfileIds, liveProfiles } = input;
  const declared = new Set(declaredProfileIds);
  const added: AddedChild[] = [];
  for (const p of liveProfiles) {
    if (declared.has(p.id)) continue;
    added.push({
      resourceType: 'AWS::AppConfig::ConfigurationProfile',
      identifier: `${applicationId}|${p.id}`, // CC composite ApplicationId|ConfigurationProfileId
      label: p.label ?? p.id,
      live: { ConfigurationProfileId: p.id, ApplicationId: applicationId },
    });
  }
  return added;
}

async function pageAppConfigProfiles(
  client: AppConfigClient,
  applicationId: string
): Promise<AppConfigConfigurationProfile[]> {
  const out: AppConfigConfigurationProfile[] = [];
  let next: string | undefined;
  do {
    const res = await client.send(
      new ListConfigurationProfilesCommand({ ApplicationId: applicationId, NextToken: next })
    );
    out.push(...(res.Items ?? []));
    next = res.NextToken;
  } while (next);
  return out;
}

async function enumerateAppConfigApplicationChildren(
  ctx: EnumeratorContext
): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const applicationId = parent.physicalId; // an Application's physical id IS its ApplicationId
  if (!applicationId) return [];

  // Declared environments of THIS application (Ref/GetAtt ApplicationId already resolved to
  // the physical id by gather). An environment's CFn physical id (Ref) IS its EnvironmentId.
  const declaredEnvironmentIds: string[] = [];
  // Declared configuration profiles of THIS application. A profile's CFn physical id (Ref)
  // IS its ConfigurationProfileId.
  const declaredProfileIds: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::AppConfig::Environment' &&
      parentRefMatches(r.declared.ApplicationId, applicationId) &&
      r.physicalId
    ) {
      declaredEnvironmentIds.push(r.physicalId);
    } else if (
      r.resourceType === 'AWS::AppConfig::ConfigurationProfile' &&
      parentRefMatches(r.declared.ApplicationId, applicationId) &&
      r.physicalId
    ) {
      declaredProfileIds.push(r.physicalId);
    }
  }

  const client = new AppConfigClient({ region, ...READ_RETRY });

  const environments = await pageAppConfigEnvironments(client, applicationId);
  const liveEnvironments = environments
    .filter((e): e is AppConfigEnvironment & { Id: string } => typeof e.Id === 'string')
    .map((e) => ({ id: e.Id, label: e.Name ?? e.Id }));
  const environmentAdded = diffAppConfigApplicationChildren({
    applicationId,
    declaredEnvironmentIds,
    liveEnvironments,
  });

  const profiles = await pageAppConfigProfiles(client, applicationId);
  const liveProfiles = profiles
    .filter((p): p is AppConfigConfigurationProfile & { Id: string } => typeof p.Id === 'string')
    .map((p) => ({ id: p.Id, label: p.Name ?? p.Id }));
  const profileAdded = diffAppConfigProfiles({
    applicationId,
    declaredProfileIds,
    liveProfiles,
  });

  return [...environmentAdded, ...profileAdded];
}

// ── EFS ──────────────────────────────────────────────────────────────────────
// An `AWS::EFS::FileSystem` owns MountTargets, each a separate CloudFormation resource.
// A console / CLI `create-mount-target` (someone attaches a new mount target to a file
// system in an out-of-band subnet) is invisible to cdk drift / CFn drift detection (they
// only compare template-declared resources). The FileSystem's own live model does NOT
// reflect its mount targets inline, so there is no double-report to suppress. The CC
// primaryIdentifier for AWS::EFS::MountTarget is the bare mount-target Id (fsmt-...),
// which CC GetResource / DeleteResource consume.

// Pure diff: declared mount-target ids + live inventory -> the added mount targets.
export interface EfsFileSystemChildInput {
  declaredMountTargetIds: string[]; // physical ids (MountTargetIds) of AWS::EFS::MountTarget
  liveMountTargets: { id: string; label?: string | undefined }[];
}

export function diffEfsFileSystemChildren(input: EfsFileSystemChildInput): AddedChild[] {
  const declared = new Set(input.declaredMountTargetIds);
  const added: AddedChild[] = [];
  for (const mt of input.liveMountTargets) {
    if (declared.has(mt.id)) continue;
    added.push({
      resourceType: 'AWS::EFS::MountTarget',
      identifier: mt.id, // the mount-target Id IS the CC primaryIdentifier
      label: mt.label ?? mt.id,
      live: { Id: mt.id },
    });
  }
  return added;
}

async function pageMountTargets(
  client: EFSClient,
  fileSystemId: string
): Promise<MountTargetDescription[]> {
  const out: MountTargetDescription[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new DescribeMountTargetsCommand({ FileSystemId: fileSystemId, Marker: marker })
    );
    out.push(...(res.MountTargets ?? []));
    marker = res.NextMarker;
  } while (marker);
  return out;
}

async function enumerateEfsFileSystemChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const fileSystemId = parent.physicalId; // a FileSystem's physical id IS its FileSystemId
  if (!fileSystemId) return [];

  // Declared mount targets of THIS file system (Ref/GetAtt FileSystemId already resolved to
  // the physical id by gather). A mount target's CFn physical id (Ref) IS its MountTargetId.
  const declaredMountTargetIds: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::EFS::MountTarget' &&
      parentRefMatches(r.declared.FileSystemId, fileSystemId) &&
      r.physicalId
    ) {
      declaredMountTargetIds.push(r.physicalId);
    }
  }

  const client = new EFSClient({ region, ...READ_RETRY });
  const mountTargets = await pageMountTargets(client, fileSystemId);
  const liveMountTargets = mountTargets
    .filter(
      (mt): mt is MountTargetDescription & { MountTargetId: string } =>
        typeof mt.MountTargetId === 'string'
    )
    .map((mt) => ({
      id: mt.MountTargetId,
      label: mt.SubnetId ? `${mt.MountTargetId} (${mt.SubnetId})` : mt.MountTargetId,
    }));

  return diffEfsFileSystemChildren({ declaredMountTargetIds, liveMountTargets });
}

// ── RDS ────────────────────────────────────────────────────────────────────────
// An `AWS::RDS::DBCluster` owns DBInstances (the cluster's writer / reader members),
// each a separate CloudFormation resource. A console / CLI `create-db-instance`
// (someone adds a new reader instance to a cluster out of band) is invisible to cdk
// drift / CFn drift detection (they only compare template-declared resources). The
// DBCluster's own live model does NOT reflect its instances inline, so there is no
// double-report to suppress. The CC primaryIdentifier for AWS::RDS::DBInstance is the
// bare DBInstanceIdentifier, which CC GetResource / DeleteResource consume.

// Pure diff: declared instance ids + live inventory -> the added DB instances.
export interface RdsClusterChildInput {
  clusterId: string; // the parent DBClusterIdentifier — anchors the implicit-member name signature
  declaredInstanceIds: string[]; // physical ids (DBInstanceIdentifiers) of AWS::RDS::DBInstance
  liveInstances: { id: string; label?: string | undefined }[];
  // DBInstanceIdentifiers the PARENT cluster reports as its own members (DBClusterMembers).
  // WARNING: membership ALONE cannot discriminate AWS-managed from out-of-band (#985). Every
  // instance in a cluster is a member, AND our live inventory source (`DescribeDBInstances`
  // filtered by `db-cluster-id`) enumerates the IDENTICAL set — so an out-of-band
  // `create-db-instance --db-cluster-identifier <cluster>` instance is a member too. Folding
  // on bare membership therefore drops EVERY instance and disables OOB detection (silent FN).
  // Instead we fold only the AWS-managed implicit members by their creation SIGNATURE: a
  // Multi-AZ DB cluster (non-Aurora, DBClusterInstanceClass set) materializes writer + reader
  // instances named `<clusterId>-instance-<N>` (AWS's documented deterministic naming). Those
  // must fold (else 3 false `[Added]` on every clean deploy — the #801-class ZERO-drift
  // violation, #896). Membership is kept as a NECESSARY condition (fold only if the id IS a
  // member AND matches the signature) — defensive: a non-member never folds by name alone.
  // (Aurora autoscaling readers `application-autoscaling-<uuid>` are excluded UPSTREAM in
  // enumerateRdsClusterChildren before the diff, so they do not reach here.)
  clusterMemberIds: string[];
}

// AWS's deterministic name for a Multi-AZ DB cluster's implicitly-materialized member instances:
// `<clusterId>-instance-<N>` (N = 1, 2, 3). Anchored + regex-escape the clusterId so a cluster id
// containing regex-special chars matches literally and an unrelated suffix does not slip through.
function isImplicitClusterMemberName(clusterId: string, instanceId: string): boolean {
  const escaped = clusterId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-instance-\\d+$`).test(instanceId);
}

export function diffRdsClusterChildren(input: RdsClusterChildInput): AddedChild[] {
  const declared = new Set(input.declaredInstanceIds);
  const clusterMembers = new Set(input.clusterMemberIds);
  const added: AddedChild[] = [];
  for (const i of input.liveInstances) {
    // Fold a declared instance, OR an AWS-managed implicit member — the latter ONLY when it is
    // both a reported cluster member AND matches the `<clusterId>-instance-<N>` signature (#985:
    // bare membership can't discriminate an out-of-band member from a managed one).
    if (
      declared.has(i.id) ||
      (clusterMembers.has(i.id) && isImplicitClusterMemberName(input.clusterId, i.id))
    )
      continue;
    added.push({
      resourceType: 'AWS::RDS::DBInstance',
      identifier: i.id, // DBInstanceIdentifier IS the CC primaryIdentifier
      label: i.label ?? i.id,
      live: { DBInstanceIdentifier: i.id },
    });
  }
  return added;
}

// Reader instances created by Aurora read-replica Application Auto Scaling
// (`rds:cluster:ReadReplicaCount`) are named with the documented, reserved
// `application-autoscaling-` DBInstanceIdentifier prefix (case-sensitive per AWS's naming).
// Match the identifier by prefix — not a substring elsewhere — so an unrelated instance that
// merely contains the string is not folded.
const AAS_MANAGED_READER_PREFIX = 'application-autoscaling-';
function isAasManagedReader(dbInstanceIdentifier: string): boolean {
  return dbInstanceIdentifier.startsWith(AAS_MANAGED_READER_PREFIX);
}

async function pageDbInstances(client: RDSClient, clusterId: string): Promise<RdsDBInstance[]> {
  const out: RdsDBInstance[] = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new DescribeDBInstancesCommand({
        Filters: [{ Name: 'db-cluster-id', Values: [clusterId] }],
        Marker: marker,
      })
    );
    out.push(...(res.DBInstances ?? []));
    marker = res.Marker;
  } while (marker);
  return out;
}

// The cluster's OWN live description authoritatively lists its members (each DBClusterMembers
// entry carries a DBInstanceIdentifier). Instances it claims are AWS-managed membership, not
// out-of-band additions — folded by diffRdsClusterChildren (see #896).
async function describeClusterMemberIds(client: RDSClient, clusterId: string): Promise<string[]> {
  const res = await client.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
  const cluster = res.DBClusters?.[0];
  return (cluster?.DBClusterMembers ?? [])
    .map((m) => m.DBInstanceIdentifier)
    .filter((id): id is string => typeof id === 'string');
}

export async function enumerateRdsClusterChildren(ctx: EnumeratorContext): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const clusterId = parent.physicalId; // a DBCluster's physical id IS its DBClusterIdentifier
  if (!clusterId) return [];

  // Declared instances of THIS cluster (Ref/GetAtt DBClusterIdentifier already resolved to
  // the physical id by gather). A DBInstance's CFn physical id (Ref) IS its DBInstanceIdentifier.
  const declaredInstanceIds: string[] = [];
  for (const r of desired.resources) {
    if (
      r.resourceType === 'AWS::RDS::DBInstance' &&
      parentRefMatches(r.declared.DBClusterIdentifier, clusterId) &&
      r.physicalId
    ) {
      declaredInstanceIds.push(r.physicalId);
    }
  }

  const client = new RDSClient({ region, ...READ_RETRY });
  const [instances, clusterMemberIds] = await Promise.all([
    pageDbInstances(client, clusterId),
    describeClusterMemberIds(client, clusterId),
  ]);
  const liveInstances = instances
    .filter(
      (i): i is RdsDBInstance & { DBInstanceIdentifier: string } =>
        typeof i.DBInstanceIdentifier === 'string' &&
        // Skip reader instances created by Aurora read-replica Application Auto Scaling
        // (`rds:cluster:ReadReplicaCount`). AWS names them `application-autoscaling-<uuid>`;
        // they are owned by the autoscaler (like an EventBridge `ManagedBy` rule), not an
        // out-of-band human change, and are not user-revertable — a scale-in/out churns the
        // identifiers, so they would otherwise be a permanent first-run false `[Added]` that
        // `record` can never stabilize and `revert` would offer to DeleteResource (#801).
        !isAasManagedReader(i.DBInstanceIdentifier)
    )
    .map((i) => ({ id: i.DBInstanceIdentifier, label: i.DBInstanceIdentifier }));

  return diffRdsClusterChildren({
    clusterId,
    declaredInstanceIds,
    liveInstances,
    clusterMemberIds,
  });
}

// ── Route53 ──────────────────────────────────────────────────────────────────
// An `AWS::Route53::HostedZone` owns RecordSets (DNS records), each a SEPARATE
// CloudFormation resource (`AWS::Route53::RecordSet`). The zone's own CC model does NOT
// carry its records, so a console / CLI / SDK `change-resource-record-sets` that CREATEs a
// record (a rogue CNAME / A / MX / NS / TXT — DNS is domain control, so a high-severity
// out-of-band change) is invisible to cdk drift / CFn drift detection: it reads CLEAN and
// survives `record`. This enumerator diffs the live `ListResourceRecordSets` inventory
// against the declared AWS::Route53::RecordSet set and flags any live record with no
// declared counterpart as `added`.
//
// IMPORTANT — revert limitation: AWS::Route53::RecordSet is NON_PROVISIONABLE in the Cloud
// Control registry (CC GetResource / DeleteResource throw UnsupportedActionException — the
// same CC gap SDK_OVERRIDES reads around). Its CC primaryIdentifier is the opaque composite
// `/properties/Id`. So a CC DeleteResource `revert` CANNOT converge an added record — the
// value here is DETECTION. Reverting a rogue record would need an SDK Route53
// ChangeResourceRecordSets DELETE path, which is OUT OF SCOPE for this enumerator. Rather
// than fabricate a revertible identifier that would fail raw at apply, the `identifier`
// carries the best composite we can build from the CC identity fields (HostedZoneId + Name +
// Type [+ SetIdentifier]) in the `<HostedZoneId>_<Name>_<Type>` shape the read override uses
// — honest, not raw-revertible.
//
// Two AWS-auto-created apex records MUST be filtered: the zone's own apex `SOA` and the apex
// `NS` record set. Both are created WITH the zone and are never template resources, so
// without a filter every clean zone shows 2 false `[Added]` on the first `check` — the same
// AWS-generated built-in pattern as the API GW `Empty`/`Error` models and the ELBv2 default
// rule. A NON-apex NS (a real sub-domain delegation record) IS template-managed and is kept.

// A record's identity is Name + Type (+ SetIdentifier for weighted/latency/geo/failover/
// multivalue variants). Route53 stores names as FQDNs with a trailing `.` and the template
// usually omits it, so compare dot- and case-insensitively.
const canonRoute53Name = (s: string): string => s.replace(/\.$/, '').toLowerCase();
const route53RecordKey = (name: string, type: string, setIdentifier?: string): string =>
  `${canonRoute53Name(name)}|${type.toUpperCase()}${setIdentifier !== undefined ? `|${setIdentifier}` : ''}`;

// Pure diff: declared record identities + live inventory -> the added (out-of-band) records.
// Separated from the SDK calls so the matching + apex-filter logic is unit-tested offline.
export interface Route53HostedZoneChildInput {
  hostedZoneId: string;
  // The zone apex domain (the HostedZone's Name), used to filter the apex NS record set.
  // May be undefined (unresolved) — then the apex is derived from the live SOA record.
  zoneApex?: string | undefined;
  declaredRecords: { name: string; type: string; setIdentifier?: string | undefined }[];
  liveRecords: {
    name: string;
    type: string;
    setIdentifier?: string | undefined;
    live?: Record<string, unknown> | undefined;
  }[];
}

export function diffRoute53HostedZoneChildren(input: Route53HostedZoneChildInput): AddedChild[] {
  const { hostedZoneId, zoneApex, declaredRecords, liveRecords } = input;
  const declared = new Set(
    declaredRecords.map((r) => route53RecordKey(r.name, r.type, r.setIdentifier))
  );
  // The apex used to filter the AWS-auto-created apex NS set. Prefer the passed zone apex;
  // fall back to the SOA record's own Name (a zone has exactly one SOA and it always sits at
  // the apex), so the NS filter still works when the apex could not be resolved.
  const soaName = liveRecords.find((r) => r.type.toUpperCase() === 'SOA')?.name;
  const apex =
    zoneApex !== undefined
      ? canonRoute53Name(zoneApex)
      : soaName !== undefined
        ? canonRoute53Name(soaName)
        : undefined;

  const added: AddedChild[] = [];
  for (const r of liveRecords) {
    const type = r.type.toUpperCase();
    const name = canonRoute53Name(r.name);
    // Skip the AWS-auto-created apex records: the zone's own SOA (only ever at the apex) and
    // the apex NS delegation set. Never template resources; filtered before the declared check
    // like the API GW `Empty`/`Error` built-in models. A non-apex NS is a real delegation and
    // is NOT filtered.
    if (type === 'SOA') continue;
    if (type === 'NS' && apex !== undefined && name === apex) continue;
    if (declared.has(route53RecordKey(r.name, r.type, r.setIdentifier))) continue;
    // NON_PROVISIONABLE in the CC registry -> this identifier is NOT raw-revertible (see the
    // block comment above); it is the best composite from the CC identity fields for display /
    // record, not a CC DeleteResource target.
    const identifier =
      `${hostedZoneId}_${r.name}_${type}` +
      (r.setIdentifier !== undefined ? `_${r.setIdentifier}` : '');
    added.push({
      resourceType: 'AWS::Route53::RecordSet',
      identifier,
      label: `${type} ${name}`,
      live: r.live ?? { Name: r.name, Type: r.type },
    });
  }
  return added;
}

// Page ListResourceRecordSets (name/type/identifier-cursor paginated: StartRecordName /
// StartRecordType / StartRecordIdentifier -> NextRecordName / NextRecordType /
// NextRecordIdentifier while IsTruncated).
async function pageResourceRecordSets(
  client: Route53Client,
  hostedZoneId: string
): Promise<ResourceRecordSet[]> {
  const out: ResourceRecordSet[] = [];
  let startName: string | undefined;
  let startType: ResourceRecordSet['Type'] | undefined;
  let startId: string | undefined;
  for (;;) {
    const res = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: startName,
        StartRecordType: startType,
        ...(startId !== undefined && { StartRecordIdentifier: startId }),
      })
    );
    out.push(...(res.ResourceRecordSets ?? []));
    if (!res.IsTruncated) break;
    startName = res.NextRecordName;
    startType = res.NextRecordType;
    startId = res.NextRecordIdentifier;
  }
  return out;
}

// Match a declared RecordSet's zone ref against THIS zone. CDK L2 emits `HostedZoneId` (Ref
// to the zone); the alternative `HostedZoneName` is the apex domain (with or without the
// trailing dot). parentRefMatches keeps a declared record whose ref is UNRESOLVED (fail-safe:
// never offer to DeleteResource a record the template explicitly declares).
function route53ZoneRefMatches(
  declared: Record<string, unknown>,
  hostedZoneId: string,
  zoneApex: string | undefined
): boolean {
  if (
    declared.HostedZoneId !== undefined &&
    parentRefMatches(declared.HostedZoneId, hostedZoneId)
  ) {
    return true;
  }
  const hzName = declared.HostedZoneName;
  if (hzName === undefined) return false;
  if (hzName === UNRESOLVED || hasUnresolved(hzName)) return true;
  return (
    typeof hzName === 'string' &&
    zoneApex !== undefined &&
    canonRoute53Name(hzName) === canonRoute53Name(zoneApex)
  );
}

export async function enumerateRoute53HostedZoneChildren(
  ctx: EnumeratorContext
): Promise<AddedChild[]> {
  const { parent, desired, region } = ctx;
  const hostedZoneId = parent.physicalId; // a HostedZone's physical id IS its zone id
  if (!hostedZoneId) return [];

  // The zone apex domain — the HostedZone's Name property (e.g. `example.com` / `example.com.`).
  // Used to filter the AWS-auto-created apex NS set.
  const zoneApex = typeof parent.declared.Name === 'string' ? parent.declared.Name : undefined;

  // Declared RecordSets targeting THIS zone (by HostedZoneId or HostedZoneName). Each is a
  // SEPARATE CloudFormation resource, so the template lists every declared one; a live record
  // matching none is out of band.
  const declaredRecords: { name: string; type: string; setIdentifier?: string | undefined }[] = [];
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::Route53::RecordSet') continue;
    if (!route53ZoneRefMatches(r.declared, hostedZoneId, zoneApex)) continue;
    const name = typeof r.declared.Name === 'string' ? r.declared.Name : undefined;
    const type = typeof r.declared.Type === 'string' ? r.declared.Type : undefined;
    if (name && type) {
      declaredRecords.push({
        name,
        type,
        setIdentifier:
          typeof r.declared.SetIdentifier === 'string' ? r.declared.SetIdentifier : undefined,
      });
    }
  }

  const client = new Route53Client({ region, ...READ_RETRY });
  const records = await pageResourceRecordSets(client, hostedZoneId);
  const liveRecords = records
    .filter(
      (r): r is ResourceRecordSet & { Name: string; Type: string } =>
        typeof r.Name === 'string' && typeof r.Type === 'string'
    )
    .map((r) => {
      const live: Record<string, unknown> = { Name: r.Name, Type: r.Type };
      if (r.TTL !== undefined) live.TTL = String(r.TTL); // CFn TTL is a string
      const values = r.ResourceRecords?.map((rr) => rr.Value).filter((v): v is string => !!v);
      if (values && values.length > 0) live.ResourceRecords = values;
      if (r.AliasTarget) live.AliasTarget = r.AliasTarget;
      return { name: r.Name, type: r.Type, setIdentifier: r.SetIdentifier, live };
    });

  return diffRoute53HostedZoneChildren({ hostedZoneId, zoneApex, declaredRecords, liveRecords });
}

// Read source router (per resource TYPE):
//   SDK override (for common types Cloud Control API can't read) → CC API
//   GetResource → skip + log. Declared/undeclared labeling happens later.
import { type CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { isResourceNotFoundError } from '../aws-errors.js';
import { OVERRIDE_READABLE_WRITEONLY } from '../schema/schema-strip.js';
import type { DesiredResource } from '../types.js';
import { SDK_OVERRIDES, SDK_SUPPLEMENTS } from './overrides.js';

export interface ReadResult {
  live?: Record<string, unknown>; // un-stripped property model
  skippedReason?: string;
  deleted?: boolean; // the resource was deleted out of band (read returned not-found)
}

// Cloud Control identifier adapters (R74): for most types the CFn physical id IS
// the CC primaryIdentifier, but not for all — passing the raw physical id then
// reads as not-found and falsely reports the resource DELETED (found live on the
// harvest3 fixture). Each adapter derives the CC identifier; returning undefined
// falls back to the physical id unchanged.
export const CC_IDENTIFIER_ADAPTERS: Record<
  string,
  (
    physicalId: string,
    declared: Record<string, unknown>,
    region?: string,
    account?: string
  ) => string | undefined
> = {
  // physical id = the API ARN (arn:...:apis/<apiId>); CC wants the bare ApiId.
  'AWS::AppSync::GraphQLApi': (pid) => (pid.startsWith('arn:') ? pid.split('/').pop() : pid),
  // Batch JobDefinition: the CFn physical id is the full ARN
  // (arn:...:job-definition/<name>:<revision>), but CC's primaryIdentifier is the
  // bare JobDefinitionName — no ARN wrapper and no `:<revision>` suffix. Verified
  // live (batch-rich fixture): both the ARN and `<name>:<revision>` return
  // InvalidRequestException ("Invalid identifier provided"); only the bare name
  // reads. Without this the JobDefinition is silently `skipped` on every check
  // (read-gap), so undeclared drift on it is invisible. Job-definition names cannot
  // contain a colon, so stripping the trailing `:<revision>` is unambiguous; the
  // bare name resolves to the active revision, which is the one the template
  // reflects.
  'AWS::Batch::JobDefinition': (pid) => {
    const tail = pid.startsWith('arn:') ? (pid.split('/').pop() ?? pid) : pid;
    return tail.replace(/:\d+$/, '');
  },
  // ECR RepositoryCreationTemplate: the primaryIdentifier is the Prefix, but the
  // service NORMALIZES a trailing `/` away (`cdkrd-hunt/` is stored as `cdkrd-hunt`)
  // while CloudFormation keeps the user's declared form (with the slash) as the
  // physical id. So CC GetResource on `cdkrd-hunt/` returns NotFound and the template
  // is falsely reported `deleted` out of band (masking every declared prop on it, and
  // a revert would plan a re-CREATE of a template that already exists). Strip the
  // trailing slash to match the stored id. Verified live (misc0cov4 fixture,
  // 2026-07-03): `cdkrd-hunt/` NotFounds, `cdkrd-hunt` reads. The literal `ROOT`
  // prefix has no slash, so it passes through untouched. The residual declared
  // `Prefix` diff (`cdkrd-hunt/` vs `cdkrd-hunt`) is folded by TRAILING_SLASH_PATHS.
  'AWS::ECR::RepositoryCreationTemplate': (pid) => pid.replace(/\/$/, ''),
  // The rest are `[<parent ref>, <child id>]` composites: the CFn physical id is
  // only the child id; the parent id comes from the resolved declared Ref. CC's
  // composite-identifier separator is `|` (verified live — R74 Cognito, R76
  // ApiGatewayV2, R77 AppConfig). An unresolved parent → fall back to the bare
  // physical id (CC then reports an honest ValidationException skip).
  'AWS::Cognito::UserPoolClient': compositeWith('UserPoolId'),
  'AWS::Cognito::UserPoolGroup': compositeWith('UserPoolId'),
  // UserPoolIdentityProvider primaryIdentifier is [UserPoolId, ProviderName]; the CFn
  // physical id is the bare ProviderName, so without the composite it ValidationExceptions
  // and the IdP is silently `skipped` (read-gap). Same UserPoolId|<child> shape as its
  // siblings — verified live (cognito-idp-rich fixture).
  'AWS::Cognito::UserPoolIdentityProvider': compositeWith('UserPoolId'),
  // UserPoolUser primaryIdentifier is [UserPoolId, Username] — parent-first. The CFn
  // physical id (Ref) is the bare Username, so without the composite CC GetResource
  // ValidationException-skips and the user is silently `skipped` (read-gap: undeclared
  // drift on the user is invisible). Same UserPoolId|<child> shape as its UserPoolClient
  // / UserPoolGroup / UserPoolDomain siblings. Verified live (cognito-userpooluser-rich):
  // `UserPoolId|Username` reads; the reverse order returns NotFound.
  'AWS::Cognito::UserPoolUser': compositeWith('UserPoolId'),
  'AWS::ApiGatewayV2::Stage': compositeWith('ApiId'),
  'AWS::ApiGatewayV2::Route': compositeWith('ApiId'),
  'AWS::ApiGatewayV2::Integration': compositeWith('ApiId'),
  // Model + Deployment are the same parent-first `[ApiId, <child>]` shape as
  // Stage/Route/Integration — the CFn physical id (Ref) is the bare ModelId /
  // DeploymentId, so a bare-id CC GetResource ValidationException-skips them (read-gap)
  // on every WebSocket API with request-validation Models or explicit Deployments, so an
  // out-of-band Model schema / Deployment description change is invisible. Verified live
  // (#872, stack CdkrdHuntUWs, us-east-1): `<ApiId>|<ModelId>` / `<ApiId>|<DeploymentId>`
  // read; the reverse orders return not-found.
  'AWS::ApiGatewayV2::Model': compositeWith('ApiId'),
  'AWS::ApiGatewayV2::Deployment': compositeWith('ApiId'),
  // ApiGatewayV2::Authorizer primaryIdentifier is [AuthorizerId, ApiId] — CHILD
  // first, the REVERSE of its v2 siblings (Stage/Route/Integration are [ApiId,
  // <child>] parent-first). The CFn physical id is the bare AuthorizerId; ApiId comes
  // from the resolved declared Ref. Verified live (httpapi-authorizer-rich): the bare
  // id ValidationException-skips until paired as `AuthorizerId|ApiId`. Child-first like
  // ECS Service, so not `compositeWith` (that is parent-first).
  'AWS::ApiGatewayV2::Authorizer': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const apiId = declared.ApiId;
    return typeof apiId === 'string' && apiId.length > 0 ? `${pid}|${apiId}` : undefined;
  },
  'AWS::AppConfig::Environment': compositeWith('ApplicationId'),
  'AWS::AppConfig::ConfigurationProfile': compositeWith('ApplicationId'),
  // AppConfig HostedConfigurationVersion + Deployment are 3-SEGMENT composites whose
  // CFn physical id is only the LAST segment (the VersionNumber / DeploymentNumber), so
  // the bare id is a CC ValidationException skip (read-gap) until paired with both
  // parents from the resolved declared Refs — in primaryIdentifier order. Verified live
  // (appconfig-deployment-readgap): HostedConfigurationVersion reads as
  // `ApplicationId|ConfigurationProfileId|VersionNumber`; Deployment reads as
  // `ApplicationId|EnvironmentId|DeploymentNumber`. An unresolved parent → fall back to
  // the bare physical id (honest skip).
  'AWS::AppConfig::HostedConfigurationVersion': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const appId = declared.ApplicationId;
    const profileId = declared.ConfigurationProfileId;
    return typeof appId === 'string' &&
      appId.length > 0 &&
      typeof profileId === 'string' &&
      profileId.length > 0
      ? `${appId}|${profileId}|${pid}`
      : undefined;
  },
  'AWS::AppConfig::Deployment': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const appId = declared.ApplicationId;
    const envId = declared.EnvironmentId;
    return typeof appId === 'string' &&
      appId.length > 0 &&
      typeof envId === 'string' &&
      envId.length > 0
      ? `${appId}|${envId}|${pid}`
      : undefined;
  },
  // ApiGateway v1 (REST) parent-first composites `[RestApiId, <child>]` and Cognito
  // `[UserPoolId, <child>]` — same parent-first `|` shape as above. The CFn physical
  // id is only the child (Model→Name, RequestValidator→RequestValidatorId,
  // Resource→ResourceId, Stage→StageName, UserPoolDomain→Domain,
  // UserPoolResourceServer→Identifier); the parent comes from the resolved declared
  // Ref. All verified live (R129): the bare child id reads as a ValidationException /
  // not-found skip until paired with its parent. (ApiGateway::Method needs NO adapter
  // — its CFn physical id is ALREADY the full `RestApiId|ResourceId|HttpMethod`.)
  'AWS::ApiGateway::Model': compositeWith('RestApiId'),
  'AWS::ApiGateway::RequestValidator': compositeWith('RestApiId'),
  'AWS::ApiGateway::Resource': compositeWith('RestApiId'),
  'AWS::ApiGateway::Stage': compositeWith('RestApiId'),
  // Authorizer primaryIdentifier is [RestApiId, AuthorizerId] — parent-first like the
  // rest of the v1 family. The CFn physical id is the bare AuthorizerId; without this
  // a DECLARED Lambda/Cognito authorizer ValidationException-skips (read-gap). Verified
  // live (restapi-authorizer-rich).
  'AWS::ApiGateway::Authorizer': compositeWith('RestApiId'),
  'AWS::Cognito::UserPoolDomain': compositeWith('UserPoolId'),
  'AWS::Cognito::UserPoolResourceServer': compositeWith('UserPoolId'),
  // AutoScaling LifecycleHook primaryIdentifier is [AutoScalingGroupName,
  // LifecycleHookName] — parent-first. The CFn physical id is the bare
  // LifecycleHookName; the ASG name comes from the resolved declared Ref. Without this
  // a declared hook ValidationException-skips (read-gap). Verified live
  // (autoscaling-lifecyclehook-rich).
  'AWS::AutoScaling::LifecycleHook': compositeWith('AutoScalingGroupName'),
  // CodeDeploy DeploymentGroup primaryIdentifier is [ApplicationName,
  // DeploymentGroupName] — parent-first. The CFn physical id (Ref) is the bare
  // DeploymentGroupName; the ApplicationName comes from the resolved declared Ref.
  // Without this a declared deployment group is a CC ValidationException skip on every
  // check (read-gap), so both undeclared drift on it AND an out-of-band change to a
  // declared property (DeploymentConfigName, AlarmConfiguration, …) are invisible.
  // Verified live (codedeploy-deploymentgroup-readgap): `ApplicationName|DeploymentGroupName`
  // reads; the reverse order returns NotFound ("No application found for name").
  'AWS::CodeDeploy::DeploymentGroup': compositeWith('ApplicationName'),
  // ElasticBeanstalk ConfigurationTemplate primaryIdentifier is [ApplicationName,
  // TemplateName] — parent-first. The CFn physical id is the bare TemplateName; the
  // ApplicationName comes from the resolved declared Ref. Without this a declared
  // configuration template is a CC ValidationException skip on every check (read-gap),
  // so both undeclared drift on it AND an out-of-band change to a declared property
  // (OptionSettings, SolutionStackName, …) are invisible. Verified live (#493,
  // CdkRealDriftHuntEbElbVpn, us-east-1): `ApplicationName|TemplateName` reads; the
  // reverse order (`TemplateName|ApplicationName`) returns NotFound.
  'AWS::ElasticBeanstalk::ConfigurationTemplate': compositeWith('ApplicationName'),
  // ElasticBeanstalk ApplicationVersion primaryIdentifier is [ApplicationName, Id] —
  // parent-first, the same shape as its ConfigurationTemplate sibling above. The CFn
  // physical id is the bare version label; the ApplicationName comes from the resolved
  // declared Ref, so it almost certainly shares the same composite read-gap. Added
  // BY ANALOGY with the live-proven ConfigurationTemplate (#493) — not separately
  // live-verified this round.
  'AWS::ElasticBeanstalk::ApplicationVersion': compositeWith('ApplicationName'),
  // AutoScaling ScheduledAction primaryIdentifier is [ScheduledActionName,
  // AutoScalingGroupName] — CHILD-first, the REVERSE of its sibling LifecycleHook
  // (parent-first). The CFn physical id is the bare ScheduledActionName; the ASG name
  // comes from the resolved declared Ref. Without this a declared scheduled action
  // ValidationException-skips (read-gap). Verified live (autoscaling-scheduledaction-rich).
  'AWS::AutoScaling::ScheduledAction': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const asg = declared.AutoScalingGroupName;
    return typeof asg === 'string' && asg.length > 0 ? `${pid}|${asg}` : undefined;
  },
  // ApiGateway::Deployment is the odd one out: its primaryIdentifier is
  // `[DeploymentId, RestApiId]` — CHILD first (verified live R129: `RestApiId|DeploymentId`
  // returns not-found; only `DeploymentId|RestApiId` reads). The CFn physical id is the
  // DeploymentId; RestApiId comes from the resolved declared Ref. Not `compositeWith`
  // (parent-first); this is child-first like ECS Service.
  'AWS::ApiGateway::Deployment': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const restApiId = declared.RestApiId;
    return typeof restApiId === 'string' && restApiId.length > 0
      ? `${pid}|${restApiId}`
      : undefined;
  },
  // ApiGateway::DocumentationPart is child-first like Deployment: its primaryIdentifier
  // is `[DocumentationPartId, RestApiId]` (verified live — `RestApiId|DocumentationPartId`
  // returns NotFound; only `DocumentationPartId|RestApiId` reads). The CFn physical id is
  // the bare DocumentationPartId; RestApiId comes from the resolved declared Ref. Without
  // this a declared documentation part is a CC ValidationException skip on every check
  // (read-gap), so undeclared drift on it is invisible. (RequestValidator/Model are
  // parent-first and already adapted above.)
  'AWS::ApiGateway::DocumentationPart': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const restApiId = declared.RestApiId;
    return typeof restApiId === 'string' && restApiId.length > 0
      ? `${pid}|${restApiId}`
      : undefined;
  },
  // ApplicationAutoScaling ScalingPolicy: primaryIdentifier is [Arn,
  // ScalableDimension]. The CFn physical id IS the PolicyARN, but ScalableDimension
  // is not a direct ScalingPolicy property — it rides on the resolved
  // `ScalingTargetId` (= the ScalableTarget physical id, formatted
  // `resourceId|scalableDimension|serviceNamespace`). Verified live (R79): the
  // PolicyARN was a CC ValidationException skip until paired with its dimension.
  'AWS::ApplicationAutoScaling::ScalingPolicy': scalingPolicyComposite,
  // ECS Service primaryIdentifier is [ServiceArn, Cluster] — the SERVICE arn FIRST,
  // then the cluster (verified live R102: either the cluster name OR arn is recorded
  // for the second segment; the reverse order is rejected). The CFn physical id is
  // the service ARN; the cluster comes from the resolved declared `Cluster` ref. Not
  // `compositeWith` (that is parent-first); ECS is child(service)-first.
  'AWS::ECS::Service': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const cluster = declared.Cluster;
    return typeof cluster === 'string' && cluster.length > 0 ? `${pid}|${cluster}` : undefined;
  },
  // Logs SubscriptionFilter primaryIdentifier is [FilterName, LogGroupName] — CHILD
  // first (the FilterName, then the parent LogGroupName), the same child-first shape
  // as ECS Service. The CFn physical id is the bare FilterName; the LogGroupName comes
  // from the resolved declared Ref. Without this a declared subscription filter is a CC
  // ValidationException skip on every check (read-gap), so both undeclared drift on it
  // AND an out-of-band FilterPattern change are invisible. Verified live
  // (logs-subscriptionfilter-rich): `FilterName|LogGroupName` reads; the reverse order
  // 404s ("The specified log group does not exist").
  'AWS::Logs::SubscriptionFilter': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const lg = declared.LogGroupName;
    return typeof lg === 'string' && lg.length > 0 ? `${pid}|${lg}` : undefined;
  },
  // Logs LogStream primaryIdentifier is [LogGroupName, LogStreamName] — PARENT first
  // (LogGroupName, then LogStreamName), unlike the child-first SubscriptionFilter. The
  // CFn physical id (Ref) is the bare LogStreamName; the LogGroupName comes from the
  // resolved declared Ref. Without this a declared log stream is a CC ValidationException
  // skip on every check (read-gap, surfaced by the dogfood-data-pipeline Firehose error
  // log stream). Verified live: `<LogGroupName>|<LogStreamName>` reads, the reverse
  // ResourceNotFoundExceptions.
  'AWS::Logs::LogStream': compositeWith('LogGroupName'),
  // SSM MaintenanceWindowTarget / MaintenanceWindowTask primaryIdentifier is
  // [WindowId, WindowTargetId] / [WindowId, WindowTaskId] (parent-first), but the CFn
  // physical id (Ref) is the bare child UUID — so CC GetResource ValidationException-skips
  // both on every check (silent read-gap on any patch-window automation). WindowId is a
  // required create prop (a Ref to the window) so it is always a resolved declared value.
  // Verified live (opsmisc-rich): `<WindowId>|<childId>` reads both; the bare child id is
  // rejected. (The sibling Athena PreparedStatement needs NO adapter — its CFn Ref is
  // already the `<StatementName>|<WorkGroup>` composite.)
  'AWS::SSM::MaintenanceWindowTarget': compositeWith('WindowId'),
  'AWS::SSM::MaintenanceWindowTask': compositeWith('WindowId'),
  // TransitGatewayRouteTablePropagation primaryIdentifier is [TransitGatewayRouteTableId,
  // TransitGatewayAttachmentId], but its CFn physical id (Ref) is the AWS console id
  // format `${attachmentId}_${routeTableId}` (underscore, ATTACHMENT first) — NOT the CC
  // composite, so CC GetResource ValidationException-skips it (read-gap). Unlike the
  // child-first adapters, BOTH composite segments are declared props, so build the
  // pipe composite directly from the resolved declared Refs (route-table FIRST, matching
  // the primaryIdentifier order). Verified live (tgw-routetable-readgap): `rtb|attach`
  // reads, the reverse and the underscore physical id both fail. (The sibling
  // RouteTableAssociation and TransitGatewayRoute need NO adapter — their CFn Ref is
  // ALREADY the full `rtb|attach` / `rtb|cidr` pipe composite.)
  'AWS::EC2::TransitGatewayRouteTablePropagation': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const rtb = declared.TransitGatewayRouteTableId;
    const att = declared.TransitGatewayAttachmentId;
    return typeof rtb === 'string' && rtb.length > 0 && typeof att === 'string' && att.length > 0
      ? `${rtb}|${att}`
      : undefined;
  },
  // VPCCidrBlock primaryIdentifier is [Id, VpcId] — CHILD (the vpc-cidr-assoc-... Id)
  // FIRST, then VpcId. The CFn physical id is only the child segment (Id), so CC
  // GetResource with the bare id ValidationException-skips it (read-gap) on every
  // dual-stack (`IpProtocol.DUAL_STACK`) or secondary-CIDR VPC — its declared props
  // (AmazonProvidedIpv6CidrBlock, CidrBlock, IPAM fields) go entirely unwatched. VpcId
  // comes from the resolved declared Ref (the VPC is in the same template by
  // construction). Verified live (#647, us-east-1): `<Id>|<VpcId>` reads; the reverse
  // order (`VpcId|Id`) returns ResourceNotFoundException. Child-first like ECS Service,
  // so not `compositeWith` (that is parent-first).
  'AWS::EC2::VPCCidrBlock': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const vpcId = declared.VpcId;
    return typeof vpcId === 'string' && vpcId.length > 0 ? `${pid}|${vpcId}` : undefined;
  },
  // ApiGatewayV2 RouteResponse primaryIdentifier is the 3-SEGMENT composite
  // [ApiId, RouteId, RouteResponseId] — parent-first (Api, then Route, then the child
  // RouteResponse), like the AppConfig HostedConfigurationVersion/Deployment 3-segment
  // adapters above. The CFn physical id is only the LAST segment (RouteResponseId), so a
  // bare-id CC GetResource ValidationException-skips it (read-gap) on every WebSocket route
  // created with CDK's `returnResponse: true` — the RouteResponse goes entirely unwatched
  // (surfaced only as `skipped=1` in the info footer). BOTH parent segments are resolvable
  // from the declared model: `ApiId` is a Ref to the Api, and `RouteId` is a Ref to the
  // Route (the Route's own physical id IS the RouteId). Verified live (#665, us-east-1):
  // `ApiId|RouteId|RouteResponseId` reads; the reversed order returns NotFound ("Invalid
  // API identifier") and the bare id ValidationExceptions. An unresolved parent → fall back
  // to the bare physical id (honest skip). Not `compositeWith` (which is a single-parent
  // helper); this is a two-parent, parent-first composite.
  'AWS::ApiGatewayV2::RouteResponse': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const apiId = declared.ApiId;
    const routeId = declared.RouteId;
    return typeof apiId === 'string' &&
      apiId.length > 0 &&
      typeof routeId === 'string' &&
      routeId.length > 0
      ? `${apiId}|${routeId}|${pid}`
      : undefined;
  },
  // ApiGatewayV2 IntegrationResponse primaryIdentifier is the 3-SEGMENT composite
  // [ApiId, IntegrationId, IntegrationResponseId] — parent-first, the same shape as its
  // RouteResponse sibling above. The CFn physical id is only the LAST segment
  // (IntegrationResponseId), so a bare-id CC GetResource ValidationException-skips it
  // (read-gap) on every non-proxy WebSocket integration — the response templates / keys
  // go entirely unwatched. BOTH parent segments are resolvable from the declared model:
  // `ApiId` is a Ref to the Api, and `IntegrationId` is the declared Ref to the
  // Integration. Verified live (#872, stack CdkrdHuntUWs, us-east-1):
  // `ApiId|IntegrationId|IntegrationResponseId` reads; the reversed order returns
  // not-found. An unresolved parent → fall back to the bare physical id (honest skip).
  'AWS::ApiGatewayV2::IntegrationResponse': (pid, declared) => {
    if (pid.includes('|')) return pid;
    const apiId = declared.ApiId;
    const integrationId = declared.IntegrationId;
    return typeof apiId === 'string' &&
      apiId.length > 0 &&
      typeof integrationId === 'string' &&
      integrationId.length > 0
      ? `${apiId}|${integrationId}|${pid}`
      : undefined;
  },
  // GuardDuty Filter primaryIdentifier is [DetectorId, Name] — parent-first. The CFn
  // physical id (Ref) is the bare filter Name, so a bare-id CC GetResource
  // ValidationException-skips it (read-gap) on every check — a security-tooling stack
  // (detector + finding filters) never sees an out-of-band filter change (e.g. a
  // weakened severity criterion hiding findings). DetectorId is a required declared
  // prop (a Ref to the detector, resolvable). Verified live (#878, stack CdkrdHuntUGd,
  // us-east-1): `<DetectorId>|<FilterName>` reads; the reverse order returns NotFound.
  'AWS::GuardDuty::Filter': compositeWith('DetectorId'),
  // Events::Rule on a CUSTOM event bus has the CFn physical id `<busName>|<ruleName>`
  // (child-enumerators.ts:1306-1317 confirms the composite shape), but the CC
  // primaryIdentifier is the single-segment rule ARN (`/properties/Arn`). Passing the
  // raw `bus|name` composite → ValidationException → the rule is silently `skipped` on
  // every check (#973, live-confirmed), so undeclared drift AND an out-of-band change to
  // a declared prop (State/EventPattern/ScheduleExpression/Targets) are invisible. CC
  // ALSO accepts the bare rule NAME, but it resolves that only against the DEFAULT bus —
  // so naively stripping the `bus|` prefix would 404 a custom-bus rule → false `deleted`
  // (the issue's explicit warning). The adapter therefore builds the FULL rule ARN
  // `arn:<partition>:events:<region>:<account>:rule/<busName>/<ruleName>`. A default-bus
  // rule (bare-name id, no `|`) and an already-ARN id pass through UNCHANGED (rule names
  // and bus names cannot contain `|`, so the pipe unambiguously marks the composite).
  // region/account come from readLive on the check path; on the revert-side call (no
  // region/account) derive the ARN from the resolved declared EventBusName when CDK set
  // it to the bus ARN (`:event-bus/<bus>` → `:rule/<bus>/<rule>`), else fall back to
  // undefined (honest skip — no worse than today).
  'AWS::Events::Rule': (pid, declared, region, account) => {
    const bar = pid.lastIndexOf('|');
    if (bar < 0) return pid; // default-bus bare name, or already the rule ARN
    const busName = pid.slice(0, bar);
    const ruleName = pid.slice(bar + 1);
    // Prefer the resolved bus ARN — works even without region/account (revert-side).
    const busArn = declared.EventBusName;
    if (typeof busArn === 'string' && busArn.includes(':event-bus/'))
      return `${busArn.replace(':event-bus/', ':rule/')}/${ruleName}`;
    if (region && account) {
      const partition = region.startsWith('cn-')
        ? 'aws-cn'
        : region.startsWith('us-gov-')
          ? 'aws-us-gov'
          : 'aws';
      return `arn:${partition}:events:${region}:${account}:rule/${busName}/${ruleName}`;
    }
    return undefined;
  },
};

// `${PolicyARN}|${ScalableDimension}` for a ScalingPolicy, extracting the
// dimension from the resolved ScalingTargetId (`resourceId|dimension|namespace`).
// The CFn schema ALSO allows the "flat" form — `ResourceId` + `ScalableDimension` +
// `ServiceNamespace` declared directly, NO `ScalingTargetId` (all createOnly,
// ScalingTargetId optional) — which raw-CFn / SAM / CDK L1 (`CfnScalingPolicy`)
// authors commonly use. In that form the dimension comes straight off
// `declared.ScalableDimension`; without this fallback the adapter returned undefined,
// cdkrd sent the bare policy ARN, and CC GetResource ValidationException-skipped it
// (permanent declared read-gap — a mutation to the policy invisible). The composite
// ORDER (`${Arn}|${dimension}`) is unchanged from the ScalingTargetId path, only the
// SOURCE of the dimension differs. undefined when neither is resolvable (→ honest skip).
// Live-surfaced by the flat-form ScalableTarget+ScalingPolicy fixture (#836).
function scalingPolicyComposite(
  pid: string,
  declared: Record<string, unknown>
): string | undefined {
  if (pid.includes('|')) return pid; // already composite — never double-suffix
  const targetId = declared.ScalingTargetId;
  const dimension =
    typeof targetId === 'string'
      ? targetId.split('|')[1]
      : typeof declared.ScalableDimension === 'string'
        ? declared.ScalableDimension
        : undefined;
  return dimension ? `${pid}|${dimension}` : undefined;
}

// Build a `${declared[parentKey]}|${physicalId}` composite CC identifier, or
// undefined when the parent ref did not resolve (→ honest skip). Never
// double-prefixes an id that is already composite.
function compositeWith(
  parentKey: string
): (pid: string, declared: Record<string, unknown>) => string | undefined {
  return (pid, declared) => {
    if (pid.includes('|')) return pid;
    const parent = declared[parentKey];
    return typeof parent === 'string' && parent.length > 0 ? `${parent}|${pid}` : undefined;
  };
}

// A supplement read failed, so its props (exempted from the writeOnly/readGap strip by
// OVERRIDE_READABLE_WRITEONLY on the assumption the supplement provides the live value)
// would false-flag as declared drift against an absent live value (#752). Restore the
// readGap for the props the user DECLARED — mirror the declared value into the live model
// so declared == live folds to no drift (the readGap outcome) — and warn on stderr naming
// the failed supplement call, so a permission gap degrades LOUDLY to coverage-incomplete
// instead of silently to false declared drift. Only exempted TOP-LEVEL props that are (a)
// declared and (b) NOT already present in the live model are mirrored (an undeclared prop
// has nothing to compare, and a prop the CC read already echoed is genuinely readable).
function restoreSupplementReadGaps(
  resourceType: string,
  declared: Record<string, unknown>,
  live: Record<string, unknown>,
  error: unknown
): void {
  const exempt = OVERRIDE_READABLE_WRITEONLY[resourceType];
  const restored: string[] = [];
  for (const path of exempt ?? []) {
    if (path in declared && !(path in live)) {
      live[path] = declared[path];
      restored.push(path);
    }
  }
  const call = (error as Error)?.name || 'unknown error';
  const gap = restored.length
    ? ` — treating ${restored.join(', ')} as an unverifiable read-gap (declared value assumed unchanged; grant the missing read permission to detect out-of-band drift on it)`
    : '';
  process.stderr.write(
    `[cdkrd] warning: supplement read for ${resourceType} failed (${call})${gap}\n`
  );
}

export async function readLive(
  cc: CloudControlClient,
  resource: DesiredResource,
  region: string,
  accountId: string
): Promise<ReadResult> {
  const { resourceType, physicalId, declared } = resource;
  // Custom resources are backed by a user Lambda; there is NO Cloud Control type to
  // read, so calling GetResource just wastes an API round-trip (+ retries) and
  // returns a misleading "ValidationException". Short-circuit to a clear skip.
  if (resourceType.startsWith('Custom::') || resourceType === 'AWS::CloudFormation::CustomResource')
    return { skippedReason: 'custom resource — no cloud-side model to read' };
  const override = SDK_OVERRIDES[resourceType];
  if (override) {
    try {
      const live = await override({ physicalId: physicalId ?? '', declared, region, accountId });
      return live
        ? { live }
        : { skippedReason: 'SDK override: target not resolvable from template' };
    } catch (e) {
      if (isResourceNotFoundError(e)) return { deleted: true };
      return { skippedReason: `SDK override (${resourceType}): ${(e as Error).name}` };
    }
  }
  try {
    const identifier =
      CC_IDENTIFIER_ADAPTERS[resourceType]?.(physicalId ?? '', declared, region, accountId) ??
      physicalId ??
      '';
    const g = await cc.send(
      new GetResourceCommand({ TypeName: resourceType, Identifier: identifier })
    );
    const live = JSON.parse(g.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
    // Supplement the CC model with writeOnly-but-SDK-readable props (e.g. SSM
    // Parameter Description) that Cloud Control never echoes. A supplement failure
    // is non-fatal: keep the CC model rather than dropping the whole read.
    const supplement = SDK_SUPPLEMENTS[resourceType];
    if (supplement) {
      try {
        const extra = await supplement({
          physicalId: physicalId ?? '',
          declared,
          region,
          accountId,
        });
        if (extra) Object.assign(live, extra);
      } catch (e) {
        // The supplement read FAILED (a missing narrow IAM permission like
        // ssm:DescribeParameters / ecs:DescribeServices / elasticache:DescribeUsers /
        // lex:DescribeBotLocale, or a transient throttle). Those props are exempted from
        // the writeOnly/readGap strip by OVERRIDE_READABLE_WRITEONLY on the ASSUMPTION the
        // supplement WILL provide the live value — so leaving them absent makes a DECLARED
        // value compare against nothing and FALSE-flag as declared-tier drift (#752). Degrade
        // LOUDLY to coverage-incomplete instead: re-fold each exempted prop the user DECLARED
        // back to a readGap by mirroring the declared value into the live model (declared ==
        // live -> no drift surfaced, exactly the readGap semantic), and warn on stderr naming
        // the failed call so the permission gap is visible rather than silent false drift.
        restoreSupplementReadGaps(resourceType, declared, live, e);
      }
    }
    return { live };
  } catch (e) {
    if (isResourceNotFoundError(e)) return { deleted: true };
    return { skippedReason: `CC API: ${(e as Error).name}` };
  }
}

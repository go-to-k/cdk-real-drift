// Read source router (per resource TYPE):
//   SDK override (for common types Cloud Control API can't read) → CC API
//   GetResource → skip + log. Declared/undeclared labeling happens later.
import { type CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { isResourceNotFoundError } from '../aws-errors.js';
import type { DesiredResource } from '../types.js';
import { SDK_OVERRIDES } from './overrides.js';

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
  (physicalId: string, declared: Record<string, unknown>) => string | undefined
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
  'AWS::ApiGatewayV2::Stage': compositeWith('ApiId'),
  'AWS::ApiGatewayV2::Route': compositeWith('ApiId'),
  'AWS::ApiGatewayV2::Integration': compositeWith('ApiId'),
  'AWS::AppConfig::Environment': compositeWith('ApplicationId'),
  'AWS::AppConfig::ConfigurationProfile': compositeWith('ApplicationId'),
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
  'AWS::Cognito::UserPoolDomain': compositeWith('UserPoolId'),
  'AWS::Cognito::UserPoolResourceServer': compositeWith('UserPoolId'),
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
};

// `${PolicyARN}|${ScalableDimension}` for a ScalingPolicy, extracting the
// dimension from the resolved ScalingTargetId (`resourceId|dimension|namespace`).
// undefined when the target ref did not resolve (→ honest skip).
function scalingPolicyComposite(
  pid: string,
  declared: Record<string, unknown>
): string | undefined {
  if (pid.includes('|')) return pid; // already composite — never double-suffix
  const targetId = declared.ScalingTargetId;
  if (typeof targetId !== 'string') return undefined;
  const dimension = targetId.split('|')[1];
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
      CC_IDENTIFIER_ADAPTERS[resourceType]?.(physicalId ?? '', declared) ?? physicalId ?? '';
    const g = await cc.send(
      new GetResourceCommand({ TypeName: resourceType, Identifier: identifier })
    );
    return { live: JSON.parse(g.ResourceDescription?.Properties ?? '{}') };
  } catch (e) {
    if (isResourceNotFoundError(e)) return { deleted: true };
    return { skippedReason: `CC API: ${(e as Error).name}` };
  }
}

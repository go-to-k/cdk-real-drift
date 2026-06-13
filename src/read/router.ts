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
  // primaryIdentifier is the composite [UserPoolId, ClientId]; the physical id is
  // only the ClientId. UserPoolId comes from the resolved declared Ref — when it
  // did not resolve, keep the physical id (CC then reports ValidationException →
  // an honest skip, same as before).
  'AWS::Cognito::UserPoolClient': (pid, declared) =>
    typeof declared.UserPoolId === 'string' && declared.UserPoolId.length > 0
      ? `${declared.UserPoolId}|${pid}`
      : undefined,
  // ApiGatewayV2 Stage/Route/Integration: primaryIdentifier is the composite
  // [ApiId, <child id>]; the CFn physical id is only the child id (StageName /
  // RouteId / IntegrationId). ApiId comes from the resolved declared Ref. CC's
  // composite-identifier separator is `|` (verified live, R76 — without this
  // these three common HTTP-API resources read as ValidationException skips).
  'AWS::ApiGatewayV2::Stage': apiGwV2Composite,
  'AWS::ApiGatewayV2::Route': apiGwV2Composite,
  'AWS::ApiGatewayV2::Integration': apiGwV2Composite,
};

function apiGwV2Composite(pid: string, declared: Record<string, unknown>): string | undefined {
  // already composite (defensive — never double-prefix) or unresolved ApiId →
  // fall back to the physical id (CC then reports an honest ValidationException skip).
  if (pid.includes('|')) return pid;
  const apiId = declared.ApiId;
  return typeof apiId === 'string' && apiId.length > 0 ? `${apiId}|${pid}` : undefined;
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

// Builds the "declared desired" view of a deployed stack:
//   GetTemplate + DescribeStackResources (phys-id map) + DescribeStacks (params)
//   → intrinsic-resolve each resource's declared properties.
// Slice scope: JSON templates (CDK app output). YAML support is a follow-up.
import {
  GetTemplateCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type CloudFormationClient,
} from '@aws-sdk/client-cloudformation';
import type { DesiredResource, ResolverContext } from '../types.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { parseCfnTemplate } from './yaml-cfn.js';

export interface Desired {
  stackName: string;
  region: string;
  accountId: string;
  resources: DesiredResource[];
  rawTemplate: string; // verbatim deployed template body (for baseline templateHash)
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
  stackId: string,
): ResolverContext {
  const params: Record<string, string> = {};
  for (const [k, def] of Object.entries((template.Parameters ?? {}) as Record<string, { Default?: unknown }>)) {
    if (def && 'Default' in def) params[k] = String(def.Default);
  }
  Object.assign(params, stackParams); // deployed values win over template defaults
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
    condCache: new Map(),
  };
}

export async function loadDesired(client: CloudFormationClient, stackName: string, region: string): Promise<Desired> {
  const [tmplRes, resRes, stkRes] = await Promise.all([
    client.send(new GetTemplateCommand({ StackName: stackName })),
    client.send(new DescribeStackResourcesCommand({ StackName: stackName })),
    client.send(new DescribeStacksCommand({ StackName: stackName })),
  ]);
  const rawTemplate = tmplRes.TemplateBody ?? '{}';
  const template = parseTemplateBody(rawTemplate) as Record<string, any>;
  const stack = stkRes.Stacks?.[0];
  const stackId = stack?.StackId ?? '';
  const accountId = stackId.split(':')[4] ?? '';

  const physIds: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  for (const r of resRes.StackResources ?? []) {
    if (r.LogicalResourceId && r.PhysicalResourceId) physIds[r.LogicalResourceId] = r.PhysicalResourceId;
    if (r.LogicalResourceId && r.ResourceType) typeOf[r.LogicalResourceId] = r.ResourceType;
  }
  const stackParams: Record<string, string> = {};
  for (const p of stack?.Parameters ?? []) if (p.ParameterKey) stackParams[p.ParameterKey] = p.ParameterValue ?? '';

  const ctx = buildResolverContext(template, stackParams, physIds, region, accountId, stackName, stackId);

  const resources: DesiredResource[] = [];
  for (const [logicalId, res] of Object.entries((template.Resources ?? {}) as Record<string, any>)) {
    if (res.Type === 'AWS::CDK::Metadata') continue;
    resources.push({
      logicalId,
      resourceType: res.Type as string,
      physicalId: physIds[logicalId],
      declared: resolveProperties((res.Properties ?? {}) as Record<string, unknown>, ctx),
    });
  }
  return { stackName, region, accountId, resources, rawTemplate };
}

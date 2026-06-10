// Builds the "declared desired" view of a deployed stack:
//   GetTemplate + DescribeStackResources (phys-id map) + DescribeStacks (params)
//   → intrinsic-resolve each resource's declared properties.
// Slice scope: JSON templates (CDK app output). YAML support is a follow-up.
import {
  type CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
} from "@aws-sdk/client-cloudformation";
import { resolveProperties } from "../normalize/intrinsic-resolver.js";
import type { DesiredResource, ResolverContext } from "../types.js";
import { parseCfnTemplate } from "./yaml-cfn.js";

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
  // CommaDelimitedList / List<> params must resolve to ARRAYS so Fn::Join /
  // Fn::Select / conditions over them evaluate correctly (a string would break
  // Fn::Join and mis-evaluate conditions like HasTrustedAccounts).
  const paramDefs = (template.Parameters ?? {}) as Record<string, { Default?: unknown; Type?: string }>;
  const isList = (k: string): boolean => {
    const t = paramDefs[k]?.Type ?? "";
    return t === "CommaDelimitedList" || t.startsWith("List<");
  };
  const toParam = (k: string, raw: string): string | string[] => (isList(k) ? (raw === "" ? [] : raw.split(",")) : raw);
  const params: Record<string, string | string[]> = {};
  for (const [k, def] of Object.entries(paramDefs)) {
    if (def && "Default" in def) params[k] = toParam(k, String(def.Default));
  }
  for (const [k, v] of Object.entries(stackParams)) params[k] = toParam(k, v); // deployed values win
  return {
    params,
    pseudo: {
      "AWS::Region": region,
      "AWS::AccountId": accountId,
      "AWS::Partition": "aws",
      "AWS::URLSuffix": "amazonaws.com",
      "AWS::StackName": stackName,
      "AWS::StackId": stackId,
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
  const rawTemplate = tmplRes.TemplateBody ?? "{}";
  const template = parseTemplateBody(rawTemplate) as Record<string, any>;
  const stack = stkRes.Stacks?.[0];
  const stackId = stack?.StackId ?? "";
  const accountId = stackId.split(":")[4] ?? "";

  const physIds: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  for (const r of resRes.StackResources ?? []) {
    if (r.LogicalResourceId && r.PhysicalResourceId) physIds[r.LogicalResourceId] = r.PhysicalResourceId;
    if (r.LogicalResourceId && r.ResourceType) typeOf[r.LogicalResourceId] = r.ResourceType;
  }
  const stackParams: Record<string, string> = {};
  for (const p of stack?.Parameters ?? []) if (p.ParameterKey) stackParams[p.ParameterKey] = p.ParameterValue ?? "";

  const ctx = buildResolverContext(template, stackParams, physIds, region, accountId, stackName, stackId);

  const resources: DesiredResource[] = [];
  // Roles whose inline Policies are managed by a SIBLING AWS::IAM::Policy resource
  // (the CDK pattern). Their live Policies would otherwise show as undeclared.
  const rolesWithSiblingPolicy = collectRolesWithSiblingPolicies(template.Resources ?? {});

  for (const [logicalId, res] of Object.entries((template.Resources ?? {}) as Record<string, any>)) {
    if (res.Type === "AWS::CDK::Metadata") continue;
    resources.push({
      logicalId,
      resourceType: res.Type as string,
      physicalId: physIds[logicalId],
      declared: resolveProperties((res.Properties ?? {}) as Record<string, unknown>, ctx),
      siblingManaged: res.Type === "AWS::IAM::Role" && rolesWithSiblingPolicy.has(logicalId),
    });
  }
  return { stackName, region, accountId, resources, rawTemplate };
}

export function collectRolesWithSiblingPolicies(resources: Record<string, any>): Set<string> {
  const roles = new Set<string>();
  for (const res of Object.values(resources)) {
    if (res?.Type !== "AWS::IAM::Policy") continue;
    for (const r of (res.Properties?.Roles ?? []) as unknown[]) {
      const ref = r && typeof r === "object" ? (r as Record<string, unknown>).Ref : undefined;
      if (typeof ref === "string") roles.add(ref);
    }
  }
  return roles;
}

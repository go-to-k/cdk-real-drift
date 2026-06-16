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
// exactly like SDK_OVERRIDES. API Gateway REST APIs are the first member.
export const CHILD_ENUMERATORS: Record<string, ChildEnumerator> = {
  'AWS::ApiGateway::RestApi': enumerateRestApiChildren,
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
  // Declared = template resources + the implicit root.
  const declaredResources = new Set(declaredResourceIds);
  if (rootResourceId) declaredResources.add(rootResourceId);
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

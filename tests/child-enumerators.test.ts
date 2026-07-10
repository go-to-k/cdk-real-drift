import {
  LambdaClient,
  ListAliasesCommand,
  ListEventSourceMappingsCommand,
  ListFunctionUrlConfigsCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { ListSubscriptionsByTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import type { EnumeratorContext } from '../src/read/child-enumerators.js';
import {
  enumerateLambdaFunctionChildren,
  enumerateRdsClusterChildren,
  enumerateRoute53HostedZoneChildren,
  enumerateSnsTopicChildren,
  diffApiGatewayAuthorizers,
  diffApiGatewayChildren,
  diffApiGatewayGatewayResponses,
  diffApiGatewayModels,
  diffApiGatewayRequestValidators,
  diffApiGatewayStages,
  diffAppConfigApplicationChildren,
  diffAppConfigProfiles,
  diffApiGatewayV2Authorizers,
  diffApiGatewayV2Children,
  diffApiGatewayV2Stages,
  diffEcsClusterChildren,
  diffEfsFileSystemChildren,
  diffEventBusChildren,
  diffGraphQLApiChildren,
  diffGraphQLApiFunctions,
  diffGraphQLApiResolvers,
  diffKmsKeyChildren,
  diffLambdaFunctionAliases,
  diffLambdaFunctionChildren,
  diffLambdaFunctionUrls,
  diffLambdaFunctionVersions,
  diffListenerChildren,
  diffLoadBalancerChildren,
  diffLogGroupChildren,
  diffLogGroupSubscriptionFilters,
  diffRdsClusterChildren,
  diffRoute53HostedZoneChildren,
  diffRouteTableChildren,
  diffSnsTopicChildren,
  diffUserPoolChildren,
  diffUserPoolGroups,
  diffUserPoolIdentityProviders,
  diffUserPoolResourceServers,
  diffVpcChildren,
  diffVpcEndpointChildren,
  diffVpcNaclChildren,
  diffVpcRouteTableChildren,
  isBodyDefinedHttpApi,
  isBodyDefinedRestApi,
  isEnumerableRoute,
  isQuickCreateHttpApi,
  routeDestination,
} from '../src/read/child-enumerators.js';

const API = 'abc123';
const ROOT = 'rootres0';

describe('diffApiGatewayChildren', () => {
  it('flags an out-of-band ANY method on the root `/` resource (the reported bug)', () => {
    // Template declares no method on root; live has an ANY method added via the console.
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`], // a declared method elsewhere
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        [ROOT]: [{ httpMethod: 'ANY' }],
        childA: [{ httpMethod: 'POST' }],
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Method',
      identifier: `${API}|${ROOT}|ANY`,
      label: 'ANY /',
    });
  });

  it('does not flag a method that IS declared on root', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [`${ROOT}|ANY`],
      liveResources: [],
      liveMethodsByResource: { [ROOT]: [{ httpMethod: 'ANY' }] },
    });
    expect(added).toEqual([]);
  });

  it('flags an out-of-band Resource and does NOT double-report its methods', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [], // 'ghost' resource is not in the template
      declaredMethodKeys: [],
      liveResources: [{ id: 'ghost', path: '/ghost' }],
      liveMethodsByResource: {
        [ROOT]: [],
        ghost: [{ httpMethod: 'GET' }, { httpMethod: 'POST' }],
      },
    });
    // Only the resource — its methods come with it (deleting the resource removes them).
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Resource',
      identifier: `${API}|ghost`,
      label: '/ghost',
    });
  });

  it('flags an undeclared method on a DECLARED child resource', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`],
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        childA: [{ httpMethod: 'POST' }, { httpMethod: 'DELETE' }], // DELETE added out of band
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Method',
      identifier: `${API}|childA|DELETE`,
      label: 'DELETE /scoring',
    });
  });

  it('is clean when every live child is declared', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`, `childA|OPTIONS`, `${ROOT}|GET`],
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        [ROOT]: [{ httpMethod: 'GET' }],
        childA: [{ httpMethod: 'POST' }, { httpMethod: 'OPTIONS' }],
      },
    });
    expect(added).toEqual([]);
  });

  it('treats the implicit root resource as declared even when listed live', () => {
    // The root `/` resource itself is never an "added Resource" (created with the API).
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      liveResources: [{ id: ROOT, path: '/' }],
      liveMethodsByResource: { [ROOT]: [] },
    });
    expect(added).toEqual([]);
  });

  it('identifies the root by its live path even when rootResourceId is UNRESOLVED (no destructive false-added)', () => {
    // The RestApi read was skipped/missing RootResourceId -> rootResourceId undefined.
    // The live root (path '/') must STILL not be flagged added (else a revert would
    // DeleteResource the API root), and its declared methods must not falsely surface.
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: undefined,
      declaredResourceIds: [],
      declaredMethodKeys: [], // unresolvable because RootResourceId didn't resolve
      liveResources: [{ id: ROOT, path: '/' }],
      liveMethodsByResource: { [ROOT]: [{ httpMethod: 'GET' }] },
    });
    expect(added).toEqual([]);
    // a genuine non-root added resource is still flagged in the same (degraded) read
    const added2 = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: undefined,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      liveResources: [
        { id: ROOT, path: '/' },
        { id: 'res9', path: '/added' },
      ],
      liveMethodsByResource: {},
    });
    expect(added2.map((a) => a.identifier)).toEqual([`${API}|res9`]);
  });

  it('suppresses ALL resource/method additions for a Body-defined (OpenAPI) RestApi (#714)', () => {
    // A SpecRestApi materializes `/ping` + its ANY method from the `Body`, with no sibling
    // AWS::ApiGateway::Resource / Method template resources — so declaredResourceIds and
    // declaredMethodKeys are empty. Without bodyDefined this flags `/ping` (+ method) as
    // out-of-band `added`; with it, they must NOT surface.
    const withoutFlag = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      liveResources: [{ id: 'pingres', path: '/ping' }],
      liveMethodsByResource: {
        [ROOT]: [],
        pingres: [{ httpMethod: 'ANY' }],
      },
    });
    // Sanity: without the fix the Body-materialized `/ping` IS flagged (the false positive).
    expect(withoutFlag.map((a) => a.identifier)).toEqual([`${API}|pingres`]);

    const withFlag = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      liveResources: [{ id: 'pingres', path: '/ping' }],
      liveMethodsByResource: {
        [ROOT]: [],
        pingres: [{ httpMethod: 'ANY' }],
      },
      bodyDefined: true,
    });
    expect(withFlag).toEqual([]);
  });
});

describe('isBodyDefinedRestApi (#714)', () => {
  it('detects a Body-defined (OpenAPI) RestApi', () => {
    expect(isBodyDefinedRestApi({ Body: { openapi: '3.0.1', paths: {} } })).toBe(true);
  });

  it('detects a BodyS3Location-defined RestApi', () => {
    expect(isBodyDefinedRestApi({ BodyS3Location: { Bucket: 'b', Key: 'spec.yaml' } })).toBe(true);
  });

  it('is false for a child-resource-defined RestApi (Name only)', () => {
    expect(isBodyDefinedRestApi({ Name: 'my-api' })).toBe(false);
  });

  it('is false when Body is absent / null', () => {
    expect(isBodyDefinedRestApi({})).toBe(false);
    expect(isBodyDefinedRestApi({ Body: null, BodyS3Location: undefined })).toBe(false);
  });
});

describe('diffApiGatewayAuthorizers (REST API authorizers)', () => {
  it('flags an out-of-band authorizer with a composite RestApiId|AuthorizerId identifier', () => {
    const added = diffApiGatewayAuthorizers({
      apiId: API,
      declaredAuthorizerIds: ['authdec0'],
      liveAuthorizers: [
        { id: 'authdec0', label: 'DeclaredAuth' },
        { id: 'authoob1', label: 'oob-authorizer' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.resourceType).toBe('AWS::ApiGateway::Authorizer');
    expect(added[0]?.identifier).toBe(`${API}|authoob1`);
    expect(added[0]?.label).toBe('oob-authorizer');
    expect(added[0]?.live).toEqual({ AuthorizerId: 'authoob1', RestApiId: API });
  });

  it('uses the live id as the label when no name is provided', () => {
    const added = diffApiGatewayAuthorizers({
      apiId: API,
      declaredAuthorizerIds: [],
      liveAuthorizers: [{ id: 'authoob2' }],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${API}|authoob2`]);
    expect(added[0]?.label).toBe('authoob2');
  });

  it('reports no drift when every live authorizer is declared', () => {
    const added = diffApiGatewayAuthorizers({
      apiId: API,
      declaredAuthorizerIds: ['authdec0', 'authdec1'],
      liveAuthorizers: [
        { id: 'authdec0', label: 'A' },
        { id: 'authdec1', label: 'B' },
      ],
    });
    expect(added).toEqual([]);
  });
});

describe('diffApiGatewayModels (REST API models)', () => {
  it('flags an out-of-band model with a composite RestApiId|Name identifier', () => {
    const added = diffApiGatewayModels({
      apiId: API,
      declaredModelNames: ['DeclaredModel'],
      liveModels: [
        { name: 'DeclaredModel', label: 'DeclaredModel' },
        { name: 'cdkrdOobModel', label: 'cdkrdOobModel' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.resourceType).toBe('AWS::ApiGateway::Model');
    expect(added[0]?.identifier).toBe(`${API}|cdkrdOobModel`);
    expect(added[0]?.label).toBe('cdkrdOobModel');
    expect(added[0]?.live).toEqual({ Name: 'cdkrdOobModel', RestApiId: API });
  });

  it('does NOT flag the AWS built-in Empty/Error models (auto-created on every RestApi)', () => {
    const added = diffApiGatewayModels({
      apiId: API,
      declaredModelNames: [],
      liveModels: [{ name: 'Empty' }, { name: 'Error' }],
    });
    expect(added).toEqual([]);
  });

  it('flags a real out-of-band model alongside the ignored built-in Empty/Error', () => {
    const added = diffApiGatewayModels({
      apiId: API,
      declaredModelNames: [],
      liveModels: [{ name: 'Empty' }, { name: 'Error' }, { name: 'cdkrdOobModel' }],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${API}|cdkrdOobModel`]);
  });

  it('reports no drift when every live model is declared', () => {
    const added = diffApiGatewayModels({
      apiId: API,
      declaredModelNames: ['Empty', 'Error', 'DeclaredModel'],
      liveModels: [{ name: 'Empty' }, { name: 'Error' }, { name: 'DeclaredModel' }],
    });
    expect(added).toEqual([]);
  });
});

describe('diffApiGatewayRequestValidators (REST API request validators)', () => {
  it('flags an out-of-band validator with a composite RestApiId|RequestValidatorId identifier', () => {
    const added = diffApiGatewayRequestValidators({
      apiId: API,
      declaredValidatorIds: ['valdec0'],
      liveValidators: [
        { id: 'valdec0', label: 'DeclaredValidator' },
        { id: 'valoob1', label: 'cdkrd-oob-validator' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.resourceType).toBe('AWS::ApiGateway::RequestValidator');
    expect(added[0]?.identifier).toBe(`${API}|valoob1`);
    expect(added[0]?.label).toBe('cdkrd-oob-validator');
    expect(added[0]?.live).toEqual({ RequestValidatorId: 'valoob1', RestApiId: API });
  });

  it('uses the live id as the label when no name is provided', () => {
    const added = diffApiGatewayRequestValidators({
      apiId: API,
      declaredValidatorIds: [],
      liveValidators: [{ id: 'valoob2' }],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${API}|valoob2`]);
    expect(added[0]?.label).toBe('valoob2');
  });

  it('reports no drift when every live validator is declared', () => {
    const added = diffApiGatewayRequestValidators({
      apiId: API,
      declaredValidatorIds: ['valdec0', 'valdec1'],
      liveValidators: [
        { id: 'valdec0', label: 'A' },
        { id: 'valdec1', label: 'B' },
      ],
    });
    expect(added).toEqual([]);
  });
});

describe('diffApiGatewayGatewayResponses (REST API gateway responses)', () => {
  it('flags an out-of-band gateway response with the colon-joined RestApiId:ResponseType identifier', () => {
    const added = diffApiGatewayGatewayResponses({
      apiId: API,
      declaredResponseTypes: ['DEFAULT_4XX'],
      liveResponseTypes: [
        { type: 'DEFAULT_4XX', label: 'DEFAULT_4XX' },
        { type: 'DEFAULT_5XX', label: 'DEFAULT_5XX' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.resourceType).toBe('AWS::ApiGateway::GatewayResponse');
    expect(added[0]?.identifier).toBe(`${API}:DEFAULT_5XX`);
    expect(added[0]?.label).toBe('DEFAULT_5XX');
    expect(added[0]?.live).toEqual({ ResponseType: 'DEFAULT_5XX', RestApiId: API });
  });

  it('uses the response type as the label when no label is provided', () => {
    const added = diffApiGatewayGatewayResponses({
      apiId: API,
      declaredResponseTypes: [],
      liveResponseTypes: [{ type: 'UNAUTHORIZED' }],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${API}:UNAUTHORIZED`]);
    expect(added[0]?.label).toBe('UNAUTHORIZED');
  });

  it('reports no drift when every live gateway response is declared', () => {
    const added = diffApiGatewayGatewayResponses({
      apiId: API,
      declaredResponseTypes: ['DEFAULT_4XX', 'DEFAULT_5XX'],
      liveResponseTypes: [
        { type: 'DEFAULT_4XX', label: 'DEFAULT_4XX' },
        { type: 'DEFAULT_5XX', label: 'DEFAULT_5XX' },
      ],
    });
    expect(added).toEqual([]);
  });

  // #1089: a declared GatewayResponse is matched ONLY by ResponseType. When that identity is
  // UNRESOLVED (dynamic ref / no-default Param / degraded ImportValue), the enumerator raises
  // hasUnresolvedDeclaredResponseType — the diff must FAIL SAFE (no live DEFAULT_4XX/5XX flagged
  // added, since a `revert --remove-unrecorded` would DeleteResource a declared response).
  it('fails safe: an UNRESOLVED declared ResponseType suppresses ALL added for this api (#1089)', () => {
    expect(
      diffApiGatewayGatewayResponses({
        apiId: API,
        declaredResponseTypes: [], // the UNRESOLVED ResponseType never reached the list
        liveResponseTypes: [{ type: 'DEFAULT_4XX' }],
        hasUnresolvedDeclaredResponseType: true,
      })
    ).toEqual([]);
  });

  it('with no UNRESOLVED declared ResponseType, a genuine out-of-band response is STILL added (#1089)', () => {
    const added = diffApiGatewayGatewayResponses({
      apiId: API,
      declaredResponseTypes: ['DEFAULT_4XX'],
      liveResponseTypes: [{ type: 'DEFAULT_4XX' }, { type: 'DEFAULT_5XX' }],
      hasUnresolvedDeclaredResponseType: false,
    });
    expect(added.map((a) => a.identifier)).toEqual([`${API}:DEFAULT_5XX`]);
  });
});

describe('diffApiGatewayV2Children (HTTP / WebSocket API)', () => {
  const APIV2 = 'v2api01';

  it('flags an out-of-band Route added via the console (not in the template)', () => {
    const added = diffApiGatewayV2Children({
      apiId: APIV2,
      declaredRouteIds: ['rDeclared'],
      declaredIntegrationIds: ['iDeclared'],
      liveRoutes: [
        { id: 'rDeclared', key: 'GET /items' },
        { id: 'rConsole', key: 'GET /admin' },
      ],
      liveIntegrations: [{ id: 'iDeclared', label: 'AWS_PROXY arn:lambda' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApiGatewayV2::Route',
        identifier: `${APIV2}|rConsole`,
        label: 'GET /admin',
        live: { RouteId: 'rConsole', RouteKey: 'GET /admin' },
      },
    ]);
  });

  it('flags an out-of-band Integration; identifier is the CC composite ApiId|IntegrationId', () => {
    const added = diffApiGatewayV2Children({
      apiId: APIV2,
      declaredRouteIds: [],
      declaredIntegrationIds: ['iDeclared'],
      liveRoutes: [],
      liveIntegrations: [
        { id: 'iDeclared', label: 'AWS_PROXY arn:a' },
        { id: 'iConsole', label: 'HTTP_PROXY https://x' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApiGatewayV2::Integration',
        identifier: `${APIV2}|iConsole`,
        label: 'HTTP_PROXY https://x',
        live: { IntegrationId: 'iConsole' },
      },
    ]);
  });

  it('no drift when every live Route + Integration is declared', () => {
    expect(
      diffApiGatewayV2Children({
        apiId: APIV2,
        declaredRouteIds: ['r1', 'r2'],
        declaredIntegrationIds: ['i1'],
        liveRoutes: [
          { id: 'r1', key: '$default' },
          { id: 'r2', key: 'POST /x' },
        ],
        liveIntegrations: [{ id: 'i1', label: 'AWS_PROXY arn' }],
      })
    ).toEqual([]);
  });

  it('falls back to the id for a Route with no RouteKey', () => {
    const added = diffApiGatewayV2Children({
      apiId: APIV2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveRoutes: [{ id: 'rX', key: undefined }],
      liveIntegrations: [],
    });
    expect(added[0]!.label).toBe('rX');
  });

  it('suppresses ALL Route/Integration additions for a spec-materialized (Body/quick-create) Api (#960)', () => {
    // A Body-defined (OpenAPI) or quick-create (Target) HTTP API materializes its routes +
    // integrations from the spec / target, with no sibling AWS::ApiGatewayV2::Route / Integration
    // template resources — so declaredRouteIds / declaredIntegrationIds are empty. Without
    // specMaterialized this flags every live route/integration as out-of-band `added` (the
    // false positive); with it, none must surface.
    const withoutFlag = diffApiGatewayV2Children({
      apiId: APIV2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveRoutes: [{ id: 'rDefault', key: '$default' }],
      liveIntegrations: [{ id: 'iProxy', label: 'AWS_PROXY arn:lambda' }],
    });
    // Sanity: without the fix the materialized $default route + integration ARE flagged.
    expect(withoutFlag.map((a) => a.identifier)).toEqual([`${APIV2}|rDefault`, `${APIV2}|iProxy`]);

    const withFlag = diffApiGatewayV2Children({
      apiId: APIV2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveRoutes: [{ id: 'rDefault', key: '$default' }],
      liveIntegrations: [{ id: 'iProxy', label: 'AWS_PROXY arn:lambda' }],
      specMaterialized: true,
    });
    expect(withFlag).toEqual([]);
  });
});

describe('diffApiGatewayV2Authorizers (HTTP / WebSocket API authorizers)', () => {
  const APIV2 = 'v2api01';

  it('flags an out-of-band Authorizer; identifier is the CC composite AuthorizerId|ApiId', () => {
    const added = diffApiGatewayV2Authorizers({
      apiId: APIV2,
      declaredAuthorizerIds: ['authDeclared'],
      liveAuthorizers: [
        { id: 'authDeclared', label: 'declared' },
        { id: 'authConsole', label: 'console-jwt' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApiGatewayV2::Authorizer',
        identifier: `authConsole|${APIV2}`,
        label: 'console-jwt',
        live: { AuthorizerId: 'authConsole', ApiId: APIV2 },
      },
    ]);
  });

  it('no drift when every live Authorizer is declared', () => {
    expect(
      diffApiGatewayV2Authorizers({
        apiId: APIV2,
        declaredAuthorizerIds: ['a1', 'a2'],
        liveAuthorizers: [
          { id: 'a1', label: 'jwt1' },
          { id: 'a2', label: 'jwt2' },
        ],
      })
    ).toEqual([]);
  });

  it('falls back to the AuthorizerId when the live Authorizer has no name', () => {
    const added = diffApiGatewayV2Authorizers({
      apiId: APIV2,
      declaredAuthorizerIds: [],
      liveAuthorizers: [{ id: 'authX', label: undefined }],
    });
    expect(added[0]!.label).toBe('authX');
  });

  it('suppresses Authorizer additions for a Body-defined (OpenAPI) Api (#960)', () => {
    // A Body-defined HTTP API materializes its authorizers from the spec's
    // x-amazon-apigateway-authorizer entries, with no sibling AWS::ApiGatewayV2::Authorizer
    // template resource — so declaredAuthorizerIds is empty. Without bodyDefined this flags the
    // spec authorizer as out-of-band `added`; with it, it must NOT surface.
    const withoutFlag = diffApiGatewayV2Authorizers({
      apiId: APIV2,
      declaredAuthorizerIds: [],
      liveAuthorizers: [{ id: 'authSpec', label: 'spec-jwt' }],
    });
    expect(withoutFlag.map((a) => a.identifier)).toEqual([`authSpec|${APIV2}`]);

    const withFlag = diffApiGatewayV2Authorizers({
      apiId: APIV2,
      declaredAuthorizerIds: [],
      liveAuthorizers: [{ id: 'authSpec', label: 'spec-jwt' }],
      bodyDefined: true,
    });
    expect(withFlag).toEqual([]);
  });
});

describe('diffApiGatewayStages (REST API stages, #1044)', () => {
  const API = 'rest01';

  it('flags an out-of-band Stage; identifier is the CC composite RestApiId|StageName', () => {
    const added = diffApiGatewayStages({
      apiId: API,
      declaredStageNames: ['prod'],
      liveStages: [
        { name: 'prod', label: 'prod' },
        { name: 'roguestage', label: 'roguestage' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApiGateway::Stage',
        identifier: `${API}|roguestage`,
        label: 'roguestage',
        live: { StageName: 'roguestage', RestApiId: API },
      },
    ]);
  });

  it('no drift when every live Stage is declared', () => {
    expect(
      diffApiGatewayStages({
        apiId: API,
        declaredStageNames: ['prod', 'staging'],
        liveStages: [{ name: 'prod' }, { name: 'staging' }],
      })
    ).toEqual([]);
  });

  it('falls back to the StageName when the live Stage has no label', () => {
    const added = diffApiGatewayStages({
      apiId: API,
      declaredStageNames: [],
      liveStages: [{ name: 'stageX', label: undefined }],
    });
    expect(added[0]!.label).toBe('stageX');
  });
});

describe('diffApiGatewayV2Stages (HTTP / WebSocket API stages)', () => {
  const APIV2 = 'v2api01';

  it('flags an out-of-band Stage; identifier is the CC composite ApiId|StageName', () => {
    const added = diffApiGatewayV2Stages({
      apiId: APIV2,
      declaredStageNames: ['prod'],
      liveStages: [
        { name: 'prod', label: 'prod' },
        { name: 'cdkrdoob', label: 'console-stage' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApiGatewayV2::Stage',
        identifier: `${APIV2}|cdkrdoob`,
        label: 'console-stage',
        live: { StageName: 'cdkrdoob', ApiId: APIV2 },
      },
    ]);
  });

  it('no drift when every live Stage is declared', () => {
    expect(
      diffApiGatewayV2Stages({
        apiId: APIV2,
        declaredStageNames: ['prod', '$default'],
        liveStages: [{ name: 'prod' }, { name: '$default' }],
      })
    ).toEqual([]);
  });

  it('falls back to the StageName when the live Stage has no label', () => {
    const added = diffApiGatewayV2Stages({
      apiId: APIV2,
      declaredStageNames: [],
      liveStages: [{ name: 'stageX', label: undefined }],
    });
    expect(added[0]!.label).toBe('stageX');
  });

  it('suppresses ONLY the $default Stage for a quick-create Api, still flags a genuine OOB stage (#960)', () => {
    // Quick create (Target) auto-creates a `$default` stage configured to auto-deploy, with no
    // sibling AWS::ApiGatewayV2::Stage template resource. Without quickCreate this flags it as
    // out-of-band `added` (destructive DeleteResource on the auto-deploy stage); with it, the
    // `$default` stage is suppressed — but a genuinely out-of-band NON-$default stage still
    // surfaces (the suppression is scoped to the quick-create-owned $default only).
    const withoutFlag = diffApiGatewayV2Stages({
      apiId: APIV2,
      declaredStageNames: [],
      liveStages: [
        { name: '$default', label: '$default' },
        { name: 'roguestage', label: 'console-stage' },
      ],
    });
    expect(withoutFlag.map((a) => a.identifier)).toEqual([
      `${APIV2}|$default`,
      `${APIV2}|roguestage`,
    ]);

    const withFlag = diffApiGatewayV2Stages({
      apiId: APIV2,
      declaredStageNames: [],
      liveStages: [
        { name: '$default', label: '$default' },
        { name: 'roguestage', label: 'console-stage' },
      ],
      quickCreate: true,
    });
    // $default is folded away; the genuinely out-of-band stage is still reported.
    expect(withFlag).toEqual([
      {
        resourceType: 'AWS::ApiGatewayV2::Stage',
        identifier: `${APIV2}|roguestage`,
        label: 'console-stage',
        live: { StageName: 'roguestage', ApiId: APIV2 },
      },
    ]);
  });
});

describe('isBodyDefinedHttpApi / isQuickCreateHttpApi (#960)', () => {
  it('detects a Body-defined (OpenAPI) HTTP API', () => {
    expect(isBodyDefinedHttpApi({ Body: { openapi: '3.0.1', paths: {} } })).toBe(true);
  });

  it('detects a BodyS3Location-defined HTTP API', () => {
    expect(isBodyDefinedHttpApi({ BodyS3Location: { Bucket: 'b', Key: 'spec.yaml' } })).toBe(true);
  });

  it('is false for a child-resource-defined HTTP API (ProtocolType only)', () => {
    expect(isBodyDefinedHttpApi({ ProtocolType: 'HTTP', Name: 'my-api' })).toBe(false);
  });

  it('is false when Body is absent / null', () => {
    expect(isBodyDefinedHttpApi({})).toBe(false);
    expect(isBodyDefinedHttpApi({ Body: null, BodyS3Location: undefined })).toBe(false);
  });

  it('detects a quick-create (Target) HTTP API', () => {
    expect(isQuickCreateHttpApi({ ProtocolType: 'HTTP', Target: 'arn:aws:lambda:...' })).toBe(true);
  });

  it('is false for a non-quick-create HTTP API (no Target)', () => {
    expect(isQuickCreateHttpApi({ ProtocolType: 'HTTP', Name: 'my-api' })).toBe(false);
    expect(isQuickCreateHttpApi({ Target: null })).toBe(false);
  });
});

describe('diffSnsTopicChildren (SNS Topic subscriptions)', () => {
  const SUB = (id: string) => `arn:aws:sns:us-east-1:111122223333:t:${id}`;

  it('flags an out-of-band subscription added via the console (not in the template)', () => {
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [SUB('declared')],
      liveSubscriptions: [
        { arn: SUB('declared'), label: 'sqs arn:queue' },
        { arn: SUB('console'), label: 'email ops@example.com' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::SNS::Subscription',
        identifier: SUB('console'),
        label: 'email ops@example.com',
        live: { SubscriptionArn: SUB('console') },
      },
    ]);
  });

  it('identifier is the bare SubscriptionArn (CC primaryIdentifier, not a composite)', () => {
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [],
      liveSubscriptions: [{ arn: SUB('x'), label: 'lambda arn:fn' }],
    });
    expect(added[0]!.identifier).toBe(SUB('x'));
  });

  it('no drift when every live subscription is declared', () => {
    expect(
      diffSnsTopicChildren({
        declaredSubscriptionArns: [SUB('a'), SUB('b')],
        liveSubscriptions: [
          { arn: SUB('a'), label: 'sqs q' },
          { arn: SUB('b'), label: 'lambda f' },
        ],
      })
    ).toEqual([]);
  });

  // AWS Chatbot (SlackChannelConfiguration / Teams / Amazon Q console) auto-subscribes its
  // fixed global endpoint to every topic a channel config points at. That subscription is
  // never in the template, so without a fold it surfaces as a false `added` out-of-band
  // resource — found on a real dev ScoringApi alarm topic, ap-northeast-1.
  it('folds the AWS Chatbot auto-created subscription (not a user out-of-band change)', () => {
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [],
      liveSubscriptions: [
        {
          arn: SUB('chatbot'),
          label: 'https https://global.sns-api.chatbot.amazonaws.com',
          endpoint: 'https://global.sns-api.chatbot.amazonaws.com',
        },
      ],
    });
    expect(added).toEqual([]);
  });

  it('a genuine https subscription to another endpoint is still flagged', () => {
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [],
      liveSubscriptions: [
        {
          arn: SUB('webhook'),
          label: 'https https://hooks.example.com/sns',
          endpoint: 'https://hooks.example.com/sns',
        },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual([SUB('webhook')]);
  });
});

describe('diffKmsKeyChildren (KMS key aliases)', () => {
  it('flags an out-of-band alias created via the console (not in the template)', () => {
    const added = diffKmsKeyChildren({
      declaredAliasNames: ['alias/declared'],
      liveAliases: [{ name: 'alias/declared' }, { name: 'alias/console' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::KMS::Alias',
        identifier: 'alias/console',
        label: 'alias/console',
        live: { AliasName: 'alias/console' },
      },
    ]);
  });

  it('identifier is the bare AliasName (CC primaryIdentifier, not a composite)', () => {
    const added = diffKmsKeyChildren({
      declaredAliasNames: [],
      liveAliases: [{ name: 'alias/x' }],
    });
    expect(added[0]!.identifier).toBe('alias/x');
  });

  it('no drift when every live alias is declared', () => {
    expect(
      diffKmsKeyChildren({
        declaredAliasNames: ['alias/a', 'alias/b'],
        liveAliases: [{ name: 'alias/a' }, { name: 'alias/b' }],
      })
    ).toEqual([]);
  });
});

describe('diffLambdaFunctionChildren (Lambda event source mappings)', () => {
  const Q = (n: string) => `arn:aws:sqs:us-east-1:111122223333:${n}`;

  it('flags an out-of-band event source mapping (not in the template)', () => {
    const added = diffLambdaFunctionChildren({
      declaredMappingIds: ['uuid-declared'],
      liveMappings: [
        { id: 'uuid-declared', label: Q('declared') },
        { id: 'uuid-console', label: Q('console') },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Lambda::EventSourceMapping',
        identifier: 'uuid-console',
        label: Q('console'),
        live: { Id: 'uuid-console' },
      },
    ]);
  });

  it('identifier is the bare mapping UUID (CC primaryIdentifier)', () => {
    const added = diffLambdaFunctionChildren({
      declaredMappingIds: [],
      liveMappings: [{ id: 'uuid-x', label: Q('x') }],
    });
    expect(added[0]!.identifier).toBe('uuid-x');
  });

  it('no drift when every live mapping is declared', () => {
    expect(
      diffLambdaFunctionChildren({
        declaredMappingIds: ['a', 'b'],
        liveMappings: [
          { id: 'a', label: Q('a') },
          { id: 'b', label: Q('b') },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffLambdaFunctionUrls (Lambda function URLs)', () => {
  const ARN = (n: string) => `arn:aws:lambda:us-east-1:111122223333:function:${n}`;

  it('flags an out-of-band function URL (not in the template)', () => {
    const added = diffLambdaFunctionUrls({
      declaredUrlArns: [ARN('FnDeclared')],
      liveUrls: [
        { arn: ARN('FnDeclared'), label: `NONE ${ARN('FnDeclared')}` },
        { arn: ARN('FnTarget'), label: `NONE ${ARN('FnTarget')}` },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Lambda::Url',
        identifier: ARN('FnTarget'),
        label: `NONE ${ARN('FnTarget')}`,
        live: { FunctionArn: ARN('FnTarget') },
      },
    ]);
  });

  it('identifier is the bare FunctionArn (CC primaryIdentifier)', () => {
    const added = diffLambdaFunctionUrls({
      declaredUrlArns: [],
      liveUrls: [{ arn: ARN('FnX') }],
    });
    expect(added[0]!.identifier).toBe(ARN('FnX'));
  });

  it('no drift when every live URL is declared', () => {
    expect(
      diffLambdaFunctionUrls({
        declaredUrlArns: [ARN('A'), ARN('B')],
        liveUrls: [
          { arn: ARN('A'), label: `NONE ${ARN('A')}` },
          { arn: ARN('B'), label: `AWS_IAM ${ARN('B')}` },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffLambdaFunctionAliases (Lambda aliases)', () => {
  const ARN = (n: string) => `arn:aws:lambda:us-east-1:111122223333:function:Fn:${n}`;

  it('flags an out-of-band alias (not in the template)', () => {
    const added = diffLambdaFunctionAliases({
      declaredAliasArns: [ARN('live')],
      liveAliases: [
        { arn: ARN('live'), label: `live ${ARN('live')}` },
        { arn: ARN('console'), label: `console ${ARN('console')}` },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Lambda::Alias',
        identifier: ARN('console'),
        label: `console ${ARN('console')}`,
        live: { AliasArn: ARN('console') },
      },
    ]);
  });

  it('identifier is the bare AliasArn (CC primaryIdentifier)', () => {
    const added = diffLambdaFunctionAliases({
      declaredAliasArns: [],
      liveAliases: [{ arn: ARN('x') }],
    });
    expect(added[0]!.identifier).toBe(ARN('x'));
  });

  it('no drift when every live alias is declared', () => {
    expect(
      diffLambdaFunctionAliases({
        declaredAliasArns: [ARN('a'), ARN('b')],
        liveAliases: [
          { arn: ARN('a'), label: `a ${ARN('a')}` },
          { arn: ARN('b'), label: `b ${ARN('b')}` },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffLambdaFunctionVersions (Lambda versions)', () => {
  const ARN = (n: string) => `arn:aws:lambda:us-east-1:111122223333:function:Fn:${n}`;

  it('flags an out-of-band version (not in the template)', () => {
    const added = diffLambdaFunctionVersions({
      declaredVersionArns: [ARN('1')],
      liveVersions: [
        { arn: ARN('1'), label: 'v1' },
        { arn: ARN('2'), label: 'v2' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Lambda::Version',
        identifier: ARN('2'),
        label: 'v2',
        live: { FunctionArn: ARN('2') },
      },
    ]);
  });

  it('identifier is the bare versioned FunctionArn (CC primaryIdentifier)', () => {
    const added = diffLambdaFunctionVersions({
      declaredVersionArns: [],
      liveVersions: [{ arn: ARN('3') }],
    });
    expect(added[0]!.identifier).toBe(ARN('3'));
  });

  it('no drift when every live version is declared', () => {
    expect(
      diffLambdaFunctionVersions({
        declaredVersionArns: [ARN('1'), ARN('2')],
        liveVersions: [
          { arn: ARN('1'), label: 'v1' },
          { arn: ARN('2'), label: 'v2' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffEventBusChildren (EventBridge rules)', () => {
  const R = (n: string) => `arn:aws:events:us-east-1:111122223333:rule/MyBus/${n}`;

  it('flags an out-of-band rule (not in the template)', () => {
    const added = diffEventBusChildren({
      busName: 'MyBus',
      isDefaultBus: false,
      declaredRuleNames: ['declared'],
      liveRules: [
        { name: 'declared', arn: R('declared') },
        { name: 'console', arn: R('console') },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Events::Rule',
        identifier: R('console'),
        label: 'console',
        live: { Name: 'console', Arn: R('console') },
        // #895: the CFn physical id for the sibling-stack lookup — `<busName>|<ruleName>` for a custom bus
        siblingLookupId: 'MyBus|console',
      },
    ]);
  });

  it('identifier is the bare rule Arn (CC primaryIdentifier)', () => {
    const added = diffEventBusChildren({
      busName: 'MyBus',
      isDefaultBus: false,
      declaredRuleNames: [],
      liveRules: [{ name: 'x', arn: R('x') }],
    });
    expect(added[0]!.identifier).toBe(R('x'));
  });

  it('#895: siblingLookupId is the `<busName>|<ruleName>` CFn physical id for a custom bus', () => {
    const added = diffEventBusChildren({
      busName: 'MyBus',
      isDefaultBus: false,
      declaredRuleNames: [],
      liveRules: [{ name: 'oob', arn: R('oob') }],
    });
    expect(added[0]!.siblingLookupId).toBe('MyBus|oob');
    // the CC identifier stays the Arn (GetResource / DeleteResource path unchanged)
    expect(added[0]!.identifier).toBe(R('oob'));
  });

  it('#895: siblingLookupId is the bare rule name for the AWS-default bus', () => {
    const added = diffEventBusChildren({
      busName: 'default',
      isDefaultBus: true,
      declaredRuleNames: [],
      liveRules: [{ name: 'oob', arn: R('oob') }],
    });
    expect(added[0]!.siblingLookupId).toBe('oob');
    expect(added[0]!.identifier).toBe(R('oob'));
  });

  it('no drift when every live rule is declared', () => {
    expect(
      diffEventBusChildren({
        busName: 'MyBus',
        isDefaultBus: false,
        declaredRuleNames: ['a', 'b'],
        liveRules: [
          { name: 'a', arn: R('a') },
          { name: 'b', arn: R('b') },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffUserPoolChildren (Cognito user pool clients)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  it('flags an out-of-band client added via the console (not in the template)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: ['client-declared'],
      liveClients: [
        { id: 'client-declared', label: 'DeclaredClient' },
        { id: 'client-console', label: 'cdkrd-integ-oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolClient',
        identifier: `${POOL}|client-console`,
        label: 'cdkrd-integ-oob',
        live: { ClientId: 'client-console' },
      },
    ]);
  });

  it('identifier is the CC composite UserPoolId|ClientId', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      liveClients: [{ id: 'client-x', label: 'X' }],
    });
    expect(added[0]!.identifier).toBe(`${POOL}|client-x`);
  });

  it('no drift when every live client is declared', () => {
    expect(
      diffUserPoolChildren({
        userPoolId: POOL,
        declaredClientIds: ['a', 'b'],
        liveClients: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      })
    ).toEqual([]);
  });

  it('skips the OpenSearch/Elasticsearch service-created Dashboards-auth clients (#897)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      liveClients: [
        // legacy Elasticsearch service prefix
        { id: 'client-es', name: 'AWSElasticsearch-abc123', label: 'AWSElasticsearch-abc123' },
        // current OpenSearch Service prefix
        {
          id: 'client-os',
          name: 'AmazonOpenSearchService-xyz',
          label: 'AmazonOpenSearchService-xyz',
        },
      ],
    });
    expect(added).toEqual([]);
  });

  it('still flags a genuinely rogue out-of-band client with an ordinary name (#897)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      liveClients: [
        { id: 'client-es', name: 'AWSElasticsearch-abc123', label: 'AWSElasticsearch-abc123' },
        { id: 'client-rogue', name: 'RogueClient', label: 'RogueClient' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolClient',
        identifier: `${POOL}|client-rogue`,
        label: 'RogueClient',
        live: { ClientId: 'client-rogue' },
      },
    ]);
  });

  it('a service-prefixed client that IS explicitly declared is matched as declared (#897)', () => {
    // Declared-set match happens first, so a declared client is never re-flagged
    // regardless of its name.
    expect(
      diffUserPoolChildren({
        userPoolId: POOL,
        declaredClientIds: ['client-declared'],
        liveClients: [
          { id: 'client-declared', name: 'AWSElasticsearch-declared', label: 'Declared' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffUserPoolGroups (Cognito user pool groups)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  it('flags an out-of-band group added via the console (not in the template)', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: ['declared-group'],
      declaredProviderNames: [],
      liveGroups: [
        { name: 'declared-group', label: 'declared-group' },
        { name: 'cdkrd-integ-oob', label: 'cdkrd-integ-oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolGroup',
        identifier: `${POOL}|cdkrd-integ-oob`,
        label: 'cdkrd-integ-oob',
        live: { GroupName: 'cdkrd-integ-oob', UserPoolId: POOL },
      },
    ]);
  });

  it('identifier is the CC composite UserPoolId|GroupName', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: [],
      declaredProviderNames: [],
      liveGroups: [{ name: 'group-x' }],
    });
    expect(added[0]!.identifier).toBe(`${POOL}|group-x`);
  });

  it('no drift when every live group is declared', () => {
    expect(
      diffUserPoolGroups({
        userPoolId: POOL,
        declaredGroupNames: ['a', 'b'],
        declaredProviderNames: [],
        liveGroups: [{ name: 'a' }, { name: 'b' }],
      })
    ).toEqual([]);
  });

  // #961: Cognito auto-creates a `<userPoolId>_<ProviderName>` group when a federated
  // user first signs in. Skip it ONLY when the pool declares an IdP with that provider
  // name — otherwise a genuinely-undeclared federation group stays surfaced.
  it('skips the auto-created <poolId>_Google group when Google is a declared provider', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: [],
      declaredProviderNames: ['Google'],
      liveGroups: [{ name: `${POOL}_Google`, label: `${POOL}_Google` }],
    });
    expect(added).toEqual([]);
  });

  it('still flags a genuinely-undeclared group even when a federated auto-group is skipped', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: ['declared-group'],
      declaredProviderNames: ['Google', 'MySAML'],
      liveGroups: [
        { name: 'declared-group' },
        { name: `${POOL}_Google` }, // auto-created, declared IdP -> skipped
        { name: `${POOL}_MySAML` }, // auto-created, declared IdP -> skipped
        { name: 'cdkrd-integ-oob' }, // genuinely out of band -> flagged
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolGroup',
        identifier: `${POOL}|cdkrd-integ-oob`,
        label: 'cdkrd-integ-oob',
        live: { GroupName: 'cdkrd-integ-oob', UserPoolId: POOL },
      },
    ]);
  });

  it('does NOT skip a <poolId>_Google group when the pool declares NO Google IdP', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: [],
      declaredProviderNames: [], // no declared IdP at all -> suspicious, keep surfaced
      liveGroups: [{ name: `${POOL}_Google` }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolGroup',
        identifier: `${POOL}|${POOL}_Google`,
        label: `${POOL}_Google`,
        live: { GroupName: `${POOL}_Google`, UserPoolId: POOL },
      },
    ]);
  });
});

describe('diffUserPoolIdentityProviders (Cognito user pool IdPs)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  // #1043: a rogue out-of-band SAML/OIDC/social IdP wired onto the pool is invisible to
  // cdk drift / CFn drift detection (an auth backdoor). Flag any live provider not declared.
  it('flags a rogue out-of-band IdP not in the declared set', () => {
    const added = diffUserPoolIdentityProviders({
      userPoolId: POOL,
      declaredProviderNames: ['MyDeclaredSAML'],
      liveProviders: [
        { providerName: 'MyDeclaredSAML', label: 'MyDeclaredSAML' },
        { providerName: 'RogueOIDC', label: 'RogueOIDC' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
        identifier: `${POOL}|RogueOIDC`,
        label: 'RogueOIDC',
        live: { ProviderName: 'RogueOIDC', UserPoolId: POOL },
      },
    ]);
  });

  it('does NOT flag a declared IdP', () => {
    expect(
      diffUserPoolIdentityProviders({
        userPoolId: POOL,
        declaredProviderNames: ['Google', 'MySAML'],
        liveProviders: [{ providerName: 'Google' }, { providerName: 'MySAML' }],
      })
    ).toEqual([]);
  });

  it('filters out the built-in Cognito native-users provider', () => {
    expect(
      diffUserPoolIdentityProviders({
        userPoolId: POOL,
        declaredProviderNames: [],
        liveProviders: [{ providerName: 'Cognito', label: 'Cognito' }],
      })
    ).toEqual([]);
  });

  it('identifier is the CC composite UserPoolId|ProviderName', () => {
    const added = diffUserPoolIdentityProviders({
      userPoolId: POOL,
      declaredProviderNames: [],
      liveProviders: [{ providerName: 'RogueSAML' }],
    });
    expect(added[0]!.identifier).toBe(`${POOL}|RogueSAML`);
  });
});

describe('diffUserPoolResourceServers (Cognito resource servers)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  it('flags an out-of-band resource server added via the console (not in the template)', () => {
    const added = diffUserPoolResourceServers({
      userPoolId: POOL,
      declaredIdentifiers: ['https://declared.cdkrd.example'],
      liveResourceServers: [
        { identifier: 'https://declared.cdkrd.example', label: 'declared' },
        { identifier: 'https://oob.cdkrd.example', label: 'oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolResourceServer',
        identifier: `${POOL}|https://oob.cdkrd.example`,
        label: 'oob',
        live: { Identifier: 'https://oob.cdkrd.example', UserPoolId: POOL },
      },
    ]);
  });

  it('identifier is the CC composite UserPoolId|Identifier', () => {
    const added = diffUserPoolResourceServers({
      userPoolId: POOL,
      declaredIdentifiers: [],
      liveResourceServers: [{ identifier: 'https://rs-x.cdkrd.example' }],
    });
    expect(added[0]!.identifier).toBe(`${POOL}|https://rs-x.cdkrd.example`);
  });

  it('no drift when every live resource server is declared', () => {
    expect(
      diffUserPoolResourceServers({
        userPoolId: POOL,
        declaredIdentifiers: ['a', 'b'],
        liveResourceServers: [{ identifier: 'a' }, { identifier: 'b' }],
      })
    ).toEqual([]);
  });
});

describe('diffLogGroupChildren (CloudWatch Logs metric filters)', () => {
  const LG = '/aws/cdkrd/integ';

  it('flags an out-of-band metric filter added via the console (not in the template)', () => {
    const added = diffLogGroupChildren({
      logGroupName: LG,
      declaredFilterNames: ['DeclaredFilter'],
      liveFilters: [
        { name: 'DeclaredFilter', label: 'DeclaredFilter' },
        { name: 'cdkrd-integ-oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Logs::MetricFilter',
        identifier: `${LG}|cdkrd-integ-oob`,
        label: 'cdkrd-integ-oob',
        live: { FilterName: 'cdkrd-integ-oob', LogGroupName: LG },
      },
    ]);
  });

  it('identifier is the CC composite LogGroupName|FilterName', () => {
    const added = diffLogGroupChildren({
      logGroupName: LG,
      declaredFilterNames: [],
      liveFilters: [{ name: 'filter-x' }],
    });
    expect(added[0]!.identifier).toBe(`${LG}|filter-x`);
  });

  it('no drift when every live filter is declared', () => {
    expect(
      diffLogGroupChildren({
        logGroupName: LG,
        declaredFilterNames: ['a', 'b'],
        liveFilters: [{ name: 'a' }, { name: 'b' }],
      })
    ).toEqual([]);
  });
});

describe('diffLogGroupSubscriptionFilters (CloudWatch Logs subscription filters)', () => {
  const LG = '/aws/cdkrd/integ';

  it('flags an out-of-band subscription filter (log exfiltration) not in the template', () => {
    const added = diffLogGroupSubscriptionFilters({
      logGroupName: LG,
      declaredFilterNames: ['DeclaredSub'],
      liveFilters: [{ name: 'DeclaredSub' }, { name: 'cdkrd-oob-sub' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Logs::SubscriptionFilter',
        // CC composite is FilterName|LogGroupName (the REVERSE of MetricFilter)
        identifier: `cdkrd-oob-sub|${LG}`,
        label: 'cdkrd-oob-sub',
        live: { FilterName: 'cdkrd-oob-sub', LogGroupName: LG },
      },
    ]);
  });

  it('no drift when every live subscription filter is declared', () => {
    expect(
      diffLogGroupSubscriptionFilters({
        logGroupName: LG,
        declaredFilterNames: ['s1'],
        liveFilters: [{ name: 's1' }],
      })
    ).toEqual([]);
  });
});

describe('diffGraphQLApiChildren (AppSync data sources)', () => {
  const DS = (n: string) => `arn:aws:appsync:us-east-1:111122223333:apis/abc/datasources/${n}`;

  it('flags an out-of-band data source added via the console (not in the template)', () => {
    const added = diffGraphQLApiChildren({
      declaredDataSourceNames: ['declared'],
      liveDataSources: [
        { name: 'declared', arn: DS('declared'), label: 'NONE declared' },
        { name: 'console', arn: DS('console'), label: 'AMAZON_DYNAMODB console' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AppSync::DataSource',
        identifier: DS('console'),
        label: 'AMAZON_DYNAMODB console',
        live: { Name: 'console', DataSourceArn: DS('console') },
      },
    ]);
  });

  it('identifier is the bare DataSourceArn (CC primaryIdentifier)', () => {
    const added = diffGraphQLApiChildren({
      declaredDataSourceNames: [],
      liveDataSources: [{ name: 'x', arn: DS('x') }],
    });
    expect(added[0]!.identifier).toBe(DS('x'));
  });

  it('no drift when every live data source is declared', () => {
    expect(
      diffGraphQLApiChildren({
        declaredDataSourceNames: ['a', 'b'],
        liveDataSources: [
          { name: 'a', arn: DS('a') },
          { name: 'b', arn: DS('b') },
        ],
      })
    ).toEqual([]);
  });

  // #1089: a declared DataSource is matched ONLY by Name. When that identity is UNRESOLVED,
  // the enumerator raises hasUnresolvedDeclaredDataSource — the diff must FAIL SAFE (no live
  // datasource flagged added, since a `revert --remove-unrecorded` would DeleteResource it).
  it('fails safe: an UNRESOLVED declared Name suppresses ALL added for this api (#1089)', () => {
    expect(
      diffGraphQLApiChildren({
        declaredDataSourceNames: [], // the UNRESOLVED Name never reached the list
        liveDataSources: [{ name: 'console', arn: DS('console') }],
        hasUnresolvedDeclaredDataSource: true,
      })
    ).toEqual([]);
  });

  it('with no UNRESOLVED declared Name, a genuine out-of-band data source is STILL added (#1089)', () => {
    const added = diffGraphQLApiChildren({
      declaredDataSourceNames: ['declared'],
      liveDataSources: [
        { name: 'declared', arn: DS('declared') },
        { name: 'console', arn: DS('console') },
      ],
      hasUnresolvedDeclaredDataSource: false,
    });
    expect(added.map((a) => a.identifier)).toEqual([DS('console')]);
  });
});

describe('diffGraphQLApiResolvers (AppSync resolvers)', () => {
  const RES = (typeName: string, fieldName: string) =>
    `arn:aws:appsync:us-east-1:111122223333:apis/abc/types/${typeName}/resolvers/${fieldName}`;

  it('flags an out-of-band resolver added via the console (not in the template)', () => {
    const added = diffGraphQLApiResolvers({
      declaredResolverKeys: ['Query|ping'],
      liveResolvers: [
        { key: 'Query|ping', arn: RES('Query', 'ping'), label: 'Query.ping' },
        { key: 'Query|pong', arn: RES('Query', 'pong'), label: 'Query.pong' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AppSync::Resolver',
        identifier: RES('Query', 'pong'),
        label: 'Query.pong',
        live: { ResolverArn: RES('Query', 'pong') },
      },
    ]);
  });

  it('identifier is the bare ResolverArn (CC primaryIdentifier)', () => {
    const added = diffGraphQLApiResolvers({
      declaredResolverKeys: [],
      liveResolvers: [{ key: 'Query|x', arn: RES('Query', 'x') }],
    });
    expect(added[0]!.identifier).toBe(RES('Query', 'x'));
  });

  it('no drift when every live resolver is declared', () => {
    expect(
      diffGraphQLApiResolvers({
        declaredResolverKeys: ['Query|a', 'Mutation|b'],
        liveResolvers: [
          { key: 'Query|a', arn: RES('Query', 'a') },
          { key: 'Mutation|b', arn: RES('Mutation', 'b') },
        ],
      })
    ).toEqual([]);
  });

  // #1089: a declared Resolver is matched ONLY by its `${TypeName}|${FieldName}` key. When
  // either identity is UNRESOLVED the enumerator raises hasUnresolvedDeclaredResolver — the
  // diff must FAIL SAFE (no live resolver flagged added → no destructive DeleteResource offer).
  it('fails safe: an UNRESOLVED declared TypeName/FieldName suppresses ALL added for this api (#1089)', () => {
    expect(
      diffGraphQLApiResolvers({
        declaredResolverKeys: [], // the UNRESOLVED key never reached the list
        liveResolvers: [{ key: 'Query|ping', arn: RES('Query', 'ping') }],
        hasUnresolvedDeclaredResolver: true,
      })
    ).toEqual([]);
  });

  it('with no UNRESOLVED declared resolver, a genuine out-of-band resolver is STILL added (#1089)', () => {
    const added = diffGraphQLApiResolvers({
      declaredResolverKeys: ['Query|ping'],
      liveResolvers: [
        { key: 'Query|ping', arn: RES('Query', 'ping') },
        { key: 'Query|pong', arn: RES('Query', 'pong') },
      ],
      hasUnresolvedDeclaredResolver: false,
    });
    expect(added.map((a) => a.identifier)).toEqual([RES('Query', 'pong')]);
  });
});

describe('diffGraphQLApiFunctions (AppSync functions)', () => {
  const FN = (id: string) => `arn:aws:appsync:us-east-1:111122223333:apis/abc/functions/${id}`;

  it('flags an out-of-band function added via the console (not in the template)', () => {
    const added = diffGraphQLApiFunctions({
      declaredFunctionArns: [FN('declared')],
      liveFunctions: [
        { arn: FN('declared'), label: 'declaredFn' },
        { arn: FN('oob'), label: 'oobFn' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AppSync::FunctionConfiguration',
        identifier: FN('oob'),
        label: 'oobFn',
        live: { FunctionArn: FN('oob') },
      },
    ]);
  });

  it('identifier is the bare FunctionArn (CC primaryIdentifier)', () => {
    const added = diffGraphQLApiFunctions({
      declaredFunctionArns: [],
      liveFunctions: [{ arn: FN('x') }],
    });
    expect(added[0]!.identifier).toBe(FN('x'));
  });

  it('no drift when every live function is declared', () => {
    expect(
      diffGraphQLApiFunctions({
        declaredFunctionArns: [FN('a'), FN('b')],
        liveFunctions: [{ arn: FN('a') }, { arn: FN('b') }],
      })
    ).toEqual([]);
  });
});

describe('diffLoadBalancerChildren (ELBv2 listeners)', () => {
  const LSN = (port: string) =>
    `arn:aws:elasticloadbalancing:us-east-1:111122223333:listener/app/alb/abc/${port}`;

  it('flags an out-of-band listener added via the console (not in the template)', () => {
    const added = diffLoadBalancerChildren({
      declaredListenerArns: [LSN('declared')],
      liveListeners: [
        { arn: LSN('declared'), label: 'HTTP:80' },
        { arn: LSN('console'), label: 'HTTP:8080' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
        identifier: LSN('console'),
        label: 'HTTP:8080',
        live: { ListenerArn: LSN('console') },
      },
    ]);
  });

  it('identifier is the bare ListenerArn (CC primaryIdentifier, not a composite)', () => {
    const added = diffLoadBalancerChildren({
      declaredListenerArns: [],
      liveListeners: [{ arn: LSN('x'), label: 'HTTPS:443' }],
    });
    expect(added[0]!.identifier).toBe(LSN('x'));
  });

  it('no drift when every live listener is declared', () => {
    expect(
      diffLoadBalancerChildren({
        declaredListenerArns: [LSN('a'), LSN('b')],
        liveListeners: [
          { arn: LSN('a'), label: 'HTTP:80' },
          { arn: LSN('b'), label: 'HTTPS:443' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffListenerChildren (ELBv2 listener rules)', () => {
  const RULE = (id: string) =>
    `arn:aws:elasticloadbalancing:us-east-1:111122223333:listener-rule/app/alb/abc/lsn/${id}`;

  it('flags an out-of-band rule added via the console (not in the template)', () => {
    const added = diffListenerChildren({
      declaredRuleArns: [RULE('declared')],
      liveRules: [
        { arn: RULE('declared'), label: 'priority 10' },
        { arn: RULE('console'), label: 'priority 50' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        identifier: RULE('console'),
        label: 'priority 50',
        live: { RuleArn: RULE('console') },
      },
    ]);
  });

  it('identifier is the bare RuleArn (CC primaryIdentifier, not a composite)', () => {
    const added = diffListenerChildren({
      declaredRuleArns: [],
      liveRules: [{ arn: RULE('x'), label: 'priority 5' }],
    });
    expect(added[0]!.identifier).toBe(RULE('x'));
  });

  it('no drift when every live rule is declared', () => {
    expect(
      diffListenerChildren({
        declaredRuleArns: [RULE('a'), RULE('b')],
        liveRules: [
          { arn: RULE('a'), label: 'priority 10' },
          { arn: RULE('b'), label: 'priority 20' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffVpcChildren (EC2 VPC subnets)', () => {
  const SN = (id: string) => `subnet-${id}`;

  it('flags an out-of-band subnet added via the console (not in the template)', () => {
    const added = diffVpcChildren({
      declaredSubnetIds: [SN('declared')],
      liveSubnets: [
        { id: SN('declared'), label: '10.0.0.0/24' },
        { id: SN('console'), label: '10.0.200.0/24' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::Subnet',
        identifier: SN('console'),
        label: '10.0.200.0/24',
        live: { SubnetId: SN('console') },
      },
    ]);
  });

  it('identifier is the bare SubnetId (CC primaryIdentifier, not a composite)', () => {
    const added = diffVpcChildren({
      declaredSubnetIds: [],
      liveSubnets: [{ id: SN('x'), label: '10.0.201.0/24' }],
    });
    expect(added[0]!.identifier).toBe(SN('x'));
  });

  it('no drift when every live subnet is declared', () => {
    expect(
      diffVpcChildren({
        declaredSubnetIds: [SN('a'), SN('b')],
        liveSubnets: [
          { id: SN('a'), label: '10.0.0.0/24' },
          { id: SN('b'), label: '10.0.1.0/24' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffVpcEndpointChildren (EC2 VPC endpoints) — #1045', () => {
  const EP = (id: string) => `vpce-${id}`;

  it('flags a rogue out-of-band VPC endpoint (not in the template)', () => {
    const added = diffVpcEndpointChildren({
      declaredEndpointIds: [EP('declared')],
      liveEndpoints: [
        { id: EP('declared'), label: 'com.amazonaws.us-east-1.s3' },
        { id: EP('rogue'), label: 'com.amazonaws.us-east-1.dynamodb' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::VPCEndpoint',
        identifier: EP('rogue'),
        label: 'com.amazonaws.us-east-1.dynamodb',
        live: { Id: EP('rogue') },
      },
    ]);
  });

  it('identifier + live.Id are the bare VpcEndpointId (CC primaryIdentifier /properties/Id)', () => {
    const added = diffVpcEndpointChildren({
      declaredEndpointIds: [],
      liveEndpoints: [{ id: EP('x'), label: 'com.amazonaws.us-east-1.s3' }],
    });
    expect(added[0]!.identifier).toBe(EP('x'));
    expect(added[0]!.live).toEqual({ Id: EP('x') });
  });

  it('no drift when every live endpoint is declared (a clean VPC has no auto-created endpoint)', () => {
    expect(
      diffVpcEndpointChildren({
        declaredEndpointIds: [EP('a'), EP('b')],
        liveEndpoints: [
          { id: EP('a'), label: 'com.amazonaws.us-east-1.s3' },
          { id: EP('b'), label: 'com.amazonaws.us-east-1.ssm' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffVpcRouteTableChildren (EC2 VPC route tables) — #1045', () => {
  const RT = (id: string) => `rtb-${id}`;

  // The MAIN route table is filtered out upstream (in the enumerator, by its
  // `Associations[].Main === true`), so the diff only ever sees non-main tables.
  it('flags a rogue out-of-band route table (not in the template)', () => {
    const added = diffVpcRouteTableChildren({
      declaredRouteTableIds: [RT('declared')],
      liveRouteTables: [{ id: RT('declared') }, { id: RT('rogue') }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::RouteTable',
        identifier: RT('rogue'),
        label: RT('rogue'),
        live: { RouteTableId: RT('rogue') },
      },
    ]);
  });

  it('identifier + live.RouteTableId are the bare RouteTableId (CC primaryIdentifier)', () => {
    const added = diffVpcRouteTableChildren({
      declaredRouteTableIds: [],
      liveRouteTables: [{ id: RT('x') }],
    });
    expect(added[0]!.identifier).toBe(RT('x'));
    expect(added[0]!.live).toEqual({ RouteTableId: RT('x') });
  });

  it('no drift when every non-main route table is declared', () => {
    expect(
      diffVpcRouteTableChildren({
        declaredRouteTableIds: [RT('a'), RT('b')],
        liveRouteTables: [{ id: RT('a') }, { id: RT('b') }],
      })
    ).toEqual([]);
  });
});

describe('diffVpcNaclChildren (EC2 VPC network ACLs) — #1045', () => {
  const ACL = (id: string) => `acl-${id}`;

  // The DEFAULT NACL is filtered out upstream (in the enumerator, by its
  // `IsDefault === true`), so the diff only ever sees non-default ACLs.
  it('flags a rogue out-of-band network ACL (not in the template)', () => {
    const added = diffVpcNaclChildren({
      declaredNaclIds: [ACL('declared')],
      liveNacls: [{ id: ACL('declared') }, { id: ACL('rogue') }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::NetworkAcl',
        identifier: ACL('rogue'),
        label: ACL('rogue'),
        live: { Id: ACL('rogue') },
      },
    ]);
  });

  it('identifier + live.Id are the bare NetworkAclId (CC primaryIdentifier /properties/Id)', () => {
    const added = diffVpcNaclChildren({
      declaredNaclIds: [],
      liveNacls: [{ id: ACL('x') }],
    });
    expect(added[0]!.identifier).toBe(ACL('x'));
    expect(added[0]!.live).toEqual({ Id: ACL('x') });
  });

  it('no drift when every non-default NACL is declared', () => {
    expect(
      diffVpcNaclChildren({
        declaredNaclIds: [ACL('a'), ACL('b')],
        liveNacls: [{ id: ACL('a') }, { id: ACL('b') }],
      })
    ).toEqual([]);
  });
});

describe('diffRdsClusterChildren (RDS DB cluster instances)', () => {
  it('flags an out-of-band DB instance added via the console (not in the template)', () => {
    const added = diffRdsClusterChildren({
      declaredInstanceIds: ['cluster-writer'],
      liveInstances: [
        { id: 'cluster-writer', label: 'cluster-writer' },
        { id: 'cdkrd-integ-oob', label: 'cdkrd-integ-oob' },
      ],
      clusterMemberIds: [],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::RDS::DBInstance',
        identifier: 'cdkrd-integ-oob',
        label: 'cdkrd-integ-oob',
        live: { DBInstanceIdentifier: 'cdkrd-integ-oob' },
      },
    ]);
  });

  it('identifier is the bare DBInstanceIdentifier (CC primaryIdentifier, not a composite)', () => {
    const added = diffRdsClusterChildren({
      declaredInstanceIds: [],
      liveInstances: [{ id: 'reader-1', label: 'reader-1' }],
      clusterMemberIds: [],
    });
    expect(added[0]!.identifier).toBe('reader-1');
  });

  it('no drift when every live DB instance is declared', () => {
    expect(
      diffRdsClusterChildren({
        declaredInstanceIds: ['writer', 'reader'],
        liveInstances: [
          { id: 'writer', label: 'writer' },
          { id: 'reader', label: 'reader' },
        ],
        clusterMemberIds: [],
      })
    ).toEqual([]);
  });

  // #896: a Multi-AZ DB cluster implicitly materializes its writer + 2 reader instances
  // (undeclared) — folded because the parent cluster reports them in DBClusterMembers; a
  // genuinely out-of-band instance (NOT a member) still surfaces.
  it('folds implicit cluster members (in DBClusterMembers) but still flags a non-member instance', () => {
    const added = diffRdsClusterChildren({
      declaredInstanceIds: [],
      liveInstances: [
        { id: 'c1-instance-1', label: 'c1-instance-1' },
        { id: 'c1-instance-2', label: 'c1-instance-2' },
        { id: 'c1-instance-3', label: 'c1-instance-3' },
        { id: 'rogue-oob', label: 'rogue-oob' },
      ],
      clusterMemberIds: ['c1-instance-1', 'c1-instance-2', 'c1-instance-3'],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::RDS::DBInstance',
        identifier: 'rogue-oob',
        label: 'rogue-oob',
        live: { DBInstanceIdentifier: 'rogue-oob' },
      },
    ]);
  });
});

describe('enumerateRdsClusterChildren (DBClusterMembers fold, #896)', () => {
  it('folds the Multi-AZ cluster member instances the parent reports, flags a non-member', async () => {
    const rds = mockClient(RDSClient);
    rds
      .on(DescribeDBInstancesCommand)
      .resolves({
        DBInstances: [
          { DBInstanceIdentifier: 'c1-instance-1' },
          { DBInstanceIdentifier: 'c1-instance-2' },
          { DBInstanceIdentifier: 'c1-instance-3' },
          { DBInstanceIdentifier: 'rogue-oob' },
        ],
      })
      .on(DescribeDBClustersCommand)
      .resolves({
        DBClusters: [
          {
            DBClusterMembers: [
              { DBInstanceIdentifier: 'c1-instance-1' },
              { DBInstanceIdentifier: 'c1-instance-2' },
              { DBInstanceIdentifier: 'c1-instance-3' },
            ],
          },
        ],
      });
    const ctx = {
      parent: { physicalId: 'c1' },
      desired: { resources: [] },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateRdsClusterChildren(ctx);
    expect(added.map((a) => a.identifier)).toEqual(['rogue-oob']);
    rds.restore();
  });

  // #801: Aurora read-replica Application Auto Scaling (`rds:cluster:ReadReplicaCount`)
  // creates reader instances named `application-autoscaling-<uuid>`. They are owned by the
  // autoscaler, not an out-of-band human change, so they must NOT surface as `added` (a
  // permanent first-run false positive; revert would offer to delete an autoscaler reader).
  it('excludes Application Auto Scaling readers (application-autoscaling-*) while keeping normal instances', async () => {
    const rds = mockClient(RDSClient);
    rds
      .on(DescribeDBInstancesCommand)
      .resolves({
        DBInstances: [
          { DBInstanceIdentifier: 'cluster-writer' },
          { DBInstanceIdentifier: 'cluster-reader' },
          { DBInstanceIdentifier: 'application-autoscaling-4d1e2f3a-0b5c-6789-abcd-ef0123456789' },
        ],
      })
      .on(DescribeDBClustersCommand)
      .resolves({
        DBClusters: [
          {
            DBClusterMembers: [
              { DBInstanceIdentifier: 'cluster-writer' },
              { DBInstanceIdentifier: 'cluster-reader' },
            ],
          },
        ],
      });
    const ctx = {
      parent: { physicalId: 'c1' },
      // Both normal instances are declared in the template.
      desired: {
        resources: [
          {
            resourceType: 'AWS::RDS::DBInstance',
            declared: { DBClusterIdentifier: 'c1' },
            physicalId: 'cluster-writer',
          },
          {
            resourceType: 'AWS::RDS::DBInstance',
            declared: { DBClusterIdentifier: 'c1' },
            physicalId: 'cluster-reader',
          },
        ],
      },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateRdsClusterChildren(ctx);
    // The AAS-managed reader is excluded from the enumeration entirely, so nothing is `added`.
    expect(added).toEqual([]);
    rds.restore();
  });

  // The prefix match is precise: an instance that merely CONTAINS the string elsewhere (not a
  // prefix) is still flagged if out of band.
  it('does not fold an instance whose identifier only contains application-autoscaling- as a substring', async () => {
    const rds = mockClient(RDSClient);
    rds
      .on(DescribeDBInstancesCommand)
      .resolves({
        DBInstances: [{ DBInstanceIdentifier: 'my-application-autoscaling-reader' }],
      })
      .on(DescribeDBClustersCommand)
      .resolves({ DBClusters: [{ DBClusterMembers: [] }] });
    const ctx = {
      parent: { physicalId: 'c1' },
      desired: { resources: [] },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateRdsClusterChildren(ctx);
    expect(added.map((a) => a.identifier)).toEqual(['my-application-autoscaling-reader']);
    rds.restore();
  });
});

describe('diffRouteTableChildren (EC2 routes)', () => {
  const RT = 'rtb-0123456789abcdef0';

  it('flags an out-of-band route added via the console (not in the template)', () => {
    const added = diffRouteTableChildren({
      routeTableId: RT,
      declaredCidrs: ['0.0.0.0/0'],
      liveRoutes: [{ cidr: '0.0.0.0/0' }, { cidr: '10.99.0.0/16' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::Route',
        identifier: `${RT}|10.99.0.0/16`,
        label: '10.99.0.0/16',
        live: { RouteTableId: RT, CidrBlock: '10.99.0.0/16' },
      },
    ]);
  });

  it('identifier is the CC composite RouteTableId|CidrBlock', () => {
    const added = diffRouteTableChildren({
      routeTableId: RT,
      declaredCidrs: [],
      liveRoutes: [{ cidr: '10.98.0.0/16' }],
    });
    expect(added[0]!.identifier).toBe(`${RT}|10.98.0.0/16`);
  });

  it('no drift when every live route is declared', () => {
    expect(
      diffRouteTableChildren({
        routeTableId: RT,
        declaredCidrs: ['0.0.0.0/0', '192.168.0.0/16'],
        liveRoutes: [{ cidr: '0.0.0.0/0' }, { cidr: '192.168.0.0/16' }],
      })
    ).toEqual([]);
  });

  // #1082: a declared AWS::EC2::Route's identity is matched ONLY through its
  // DestinationCidrBlock (the CFn physical id is a generated token). When that cidr is
  // UNRESOLVED (a `{{resolve:ssm:...}}` dynamic ref, a degraded Fn::ImportValue, or a
  // no-default NoEcho Ref → the UNRESOLVED symbol) the enumerator sets
  // `hasUnresolvedDeclaredRoute`, and the diff must FAIL SAFE: it cannot match the declared
  // route to any live cidr, so it must NOT flag any live route `added` (a `revert
  // --remove-unrecorded` would then destructively DeleteResource a route the template
  // declares).
  it('fails safe: an UNRESOLVED declared cidr suppresses ALL added for this table (#1082)', () => {
    expect(
      diffRouteTableChildren({
        routeTableId: RT,
        // The declared cidr was UNRESOLVED, so it never made it into declaredCidrs; the
        // enumerator instead raised the fail-safe flag.
        declaredCidrs: [],
        liveRoutes: [{ cidr: '10.99.0.0/16' }],
        hasUnresolvedDeclaredRoute: true,
      })
    ).toEqual([]);
  });

  it('with no UNRESOLVED declared route, a genuinely out-of-band route is STILL added (no regression, #1082)', () => {
    const added = diffRouteTableChildren({
      routeTableId: RT,
      declaredCidrs: ['0.0.0.0/0'],
      liveRoutes: [{ cidr: '0.0.0.0/0' }, { cidr: '10.99.0.0/16' }],
      hasUnresolvedDeclaredRoute: false,
    });
    expect(added.map((a) => a.identifier)).toEqual([`${RT}|10.99.0.0/16`]);
  });

  describe('isEnumerableRoute', () => {
    it('keeps a user-declarable route (manual CreateRoute with a real CIDR)', () => {
      expect(
        isEnumerableRoute({
          DestinationCidrBlock: '10.99.0.0/16',
          Origin: 'CreateRoute',
          GatewayId: 'igw-123',
        })
      ).toBe(true);
    });

    it('excludes the auto-created VPC-local route', () => {
      expect(
        isEnumerableRoute({
          DestinationCidrBlock: '10.0.0.0/16',
          Origin: 'CreateRouteTable',
          GatewayId: 'local',
        })
      ).toBe(false);
    });

    it('excludes a VGW-propagated route (Origin EnableVgwRoutePropagation) — not a declarable resource', () => {
      // The reported false-`added`: a route table with EnableVgwRoutePropagation:true
      // gets BGP/propagated routes with a real CIDR and a VGW GatewayId (not 'local'),
      // so the old filter let them through and flagged each as an out-of-band Route.
      expect(
        isEnumerableRoute({
          DestinationCidrBlock: '172.16.0.0/16',
          Origin: 'EnableVgwRoutePropagation',
          GatewayId: 'vgw-0abc123',
        })
      ).toBe(false);
    });

    // #1081: an IPv6 route (DestinationIpv6CidrBlock, e.g. a rogue `::/0`) IS a user-declarable
    // AWS::EC2::Route and a real traffic-redirection vector — it must be enumerable. Previously
    // dropped (the filter required a string DestinationCidrBlock), a silent FN on dual-stack VPCs.
    it('includes an IPv6 route (DestinationIpv6CidrBlock) — #1081', () => {
      expect(
        isEnumerableRoute({
          DestinationIpv6CidrBlock: '::/0',
          Origin: 'CreateRoute',
          GatewayId: 'igw-123',
        })
      ).toBe(true);
    });

    it('includes a managed-prefix-list route (DestinationPrefixListId) — #1081', () => {
      expect(
        isEnumerableRoute({
          DestinationPrefixListId: 'pl-0abc123',
          Origin: 'CreateRoute',
          GatewayId: 'igw-123',
        })
      ).toBe(true);
    });

    it('still excludes a route with no user-declarable destination', () => {
      expect(isEnumerableRoute({ Origin: 'CreateRoute', GatewayId: 'igw-123' })).toBe(false);
    });

    it('still excludes the auto-created VPC-local route even on the IPv6 destination', () => {
      expect(
        isEnumerableRoute({
          DestinationIpv6CidrBlock: 'fd00::/8',
          Origin: 'CreateRouteTable',
          GatewayId: 'local',
        })
      ).toBe(false);
    });
  });

  describe('routeDestination (#1081)', () => {
    it('returns the IPv4 DestinationCidrBlock', () => {
      expect(routeDestination({ DestinationCidrBlock: '10.0.0.0/16' })).toBe('10.0.0.0/16');
    });
    it('returns the IPv6 DestinationIpv6CidrBlock', () => {
      expect(routeDestination({ DestinationIpv6CidrBlock: '::/0' })).toBe('::/0');
    });
    it('returns the DestinationPrefixListId', () => {
      expect(routeDestination({ DestinationPrefixListId: 'pl-0abc123' })).toBe('pl-0abc123');
    });
    it('returns undefined when no destination is set (propagated/local route)', () => {
      expect(routeDestination({ Origin: 'CreateRouteTable', GatewayId: 'local' })).toBeUndefined();
    });
  });

  describe('diffRouteTableChildren across destination shapes (#1081)', () => {
    it('flags an out-of-band IPv6 route with the RouteTableId|<v6-cidr> identifier', () => {
      const added = diffRouteTableChildren({
        routeTableId: RT,
        declaredCidrs: [],
        liveRoutes: [{ cidr: '::/0' }],
      });
      expect(added).toEqual([
        {
          resourceType: 'AWS::EC2::Route',
          identifier: `${RT}|::/0`,
          label: '::/0',
          live: { RouteTableId: RT, CidrBlock: '::/0' },
        },
      ]);
    });

    it('flags a rogue prefix-list route but NOT a DECLARED one (both sides now see prefix lists)', () => {
      const added = diffRouteTableChildren({
        routeTableId: RT,
        declaredCidrs: ['pl-declared'],
        liveRoutes: [{ cidr: 'pl-declared' }, { cidr: 'pl-rogue' }],
      });
      expect(added.map((a) => a.identifier)).toEqual([`${RT}|pl-rogue`]);
    });
  });
});

describe('diffEcsClusterChildren (ECS services)', () => {
  const CLUSTER = 'my-cluster';
  const DECL = 'arn:aws:ecs:us-east-1:111122223333:service/my-cluster/declared-svc';
  const OOB = 'arn:aws:ecs:us-east-1:111122223333:service/my-cluster/cdkrd-oob-svc';

  it('flags an out-of-band service added via the console (not in the template)', () => {
    const added = diffEcsClusterChildren({
      cluster: CLUSTER,
      declaredServiceArns: [DECL],
      liveServices: [
        { arn: DECL, label: 'declared-svc' },
        { arn: OOB, label: 'cdkrd-oob-svc' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ECS::Service',
        identifier: `${OOB}|${CLUSTER}`,
        label: 'cdkrd-oob-svc',
        live: { ServiceArn: OOB },
      },
    ]);
  });

  it('identifier is the CC composite ServiceArn|Cluster', () => {
    const added = diffEcsClusterChildren({
      cluster: CLUSTER,
      declaredServiceArns: [],
      liveServices: [{ arn: OOB }],
    });
    expect(added[0]!.identifier).toBe(`${OOB}|${CLUSTER}`);
  });

  it('no drift when every live service is declared', () => {
    expect(
      diffEcsClusterChildren({
        cluster: CLUSTER,
        declaredServiceArns: [DECL, OOB],
        liveServices: [{ arn: DECL }, { arn: OOB }],
      })
    ).toEqual([]);
  });
});

describe('diffAppConfigApplicationChildren (AppConfig application environments)', () => {
  const APP = 'abc1234';

  it('flags an out-of-band environment added via the console (not in the template)', () => {
    const added = diffAppConfigApplicationChildren({
      applicationId: APP,
      declaredEnvironmentIds: ['env-declared'],
      liveEnvironments: [
        { id: 'env-declared', label: 'declared' },
        { id: 'env-console', label: 'cdkrd-integ-oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AppConfig::Environment',
        identifier: `${APP}|env-console`,
        label: 'cdkrd-integ-oob',
        live: { EnvironmentId: 'env-console', ApplicationId: APP },
      },
    ]);
  });

  it('identifier is the CC composite ApplicationId|EnvironmentId', () => {
    const added = diffAppConfigApplicationChildren({
      applicationId: APP,
      declaredEnvironmentIds: [],
      liveEnvironments: [{ id: 'env-x', label: 'X' }],
    });
    expect(added[0]!.identifier).toBe(`${APP}|env-x`);
  });

  it('no drift when every live environment is declared', () => {
    expect(
      diffAppConfigApplicationChildren({
        applicationId: APP,
        declaredEnvironmentIds: ['a', 'b'],
        liveEnvironments: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffAppConfigProfiles (AppConfig application configuration profiles)', () => {
  const APP = 'abc1234';

  it('flags an out-of-band configuration profile added via the console (not in the template)', () => {
    const added = diffAppConfigProfiles({
      applicationId: APP,
      declaredProfileIds: ['prof-declared'],
      liveProfiles: [
        { id: 'prof-declared', label: 'declared' },
        { id: 'prof-console', label: 'cdkrd-integ-oob' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AppConfig::ConfigurationProfile',
        identifier: `${APP}|prof-console`,
        label: 'cdkrd-integ-oob',
        live: { ConfigurationProfileId: 'prof-console', ApplicationId: APP },
      },
    ]);
  });

  it('identifier is the CC composite ApplicationId|ConfigurationProfileId', () => {
    const added = diffAppConfigProfiles({
      applicationId: APP,
      declaredProfileIds: [],
      liveProfiles: [{ id: 'prof-x', label: 'X' }],
    });
    expect(added[0]!.identifier).toBe(`${APP}|prof-x`);
  });

  it('no drift when every live configuration profile is declared', () => {
    expect(
      diffAppConfigProfiles({
        applicationId: APP,
        declaredProfileIds: ['a', 'b'],
        liveProfiles: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      })
    ).toEqual([]);
  });
});

describe('diffEfsFileSystemChildren (EFS file system mount targets)', () => {
  const MT = (id: string) => `fsmt-${id}`;

  it('flags an out-of-band mount target added via the console (not in the template)', () => {
    const added = diffEfsFileSystemChildren({
      declaredMountTargetIds: [MT('declared')],
      liveMountTargets: [
        { id: MT('declared'), label: `${MT('declared')} (subnet-a)` },
        { id: MT('console'), label: `${MT('console')} (subnet-b)` },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EFS::MountTarget',
        identifier: MT('console'),
        label: `${MT('console')} (subnet-b)`,
        live: { Id: MT('console') },
      },
    ]);
  });

  it('identifier is the bare mount-target Id (CC primaryIdentifier, not a composite)', () => {
    const added = diffEfsFileSystemChildren({
      declaredMountTargetIds: [],
      liveMountTargets: [{ id: MT('x'), label: `${MT('x')} (subnet-c)` }],
    });
    expect(added[0]!.identifier).toBe(MT('x'));
  });

  it('no drift when every live mount target is declared', () => {
    expect(
      diffEfsFileSystemChildren({
        declaredMountTargetIds: [MT('a'), MT('b')],
        liveMountTargets: [
          { id: MT('a'), label: `${MT('a')} (subnet-a)` },
          { id: MT('b'), label: `${MT('b')} (subnet-b)` },
        ],
      })
    ).toEqual([]);
  });
});

// #962: when a declared child's parent-linking property could not be resolved by the
// intrinsic resolver (a `{{resolve:...}}` dynamic ref, a no-default Parameter Ref, a
// degraded Fn::ImportValue, a non-string Fn::Sub, or a malformed Fn::Join that fails
// closed), that property is the UNRESOLVED symbol — never a plain string that could match
// the parent's physical id/ARN. A bare `===` match then failed, the declared child was
// dropped from the declared set, and its LIVE counterpart was falsely flagged `[Added]`
// (offering a DESTRUCTIVE DeleteResource against a resource the template declares). The
// enumerators must fail SAFE: an UNRESOLVED parent-ref counts as a potential match, so the
// declared child stays in the declared set and is NOT flagged added.
describe('child enumerators fail safe on an UNRESOLVED parent-ref (#962)', () => {
  it('Lambda alias: an UNRESOLVED FunctionName is NOT flagged added (defect 1)', async () => {
    const aliasArn = 'arn:aws:lambda:us-east-1:111122223333:function:my-fn:live';
    const lambda = mockClient(LambdaClient);
    lambda
      .on(ListEventSourceMappingsCommand)
      .resolves({ EventSourceMappings: [] })
      .on(ListFunctionUrlConfigsCommand)
      .resolves({ FunctionUrlConfigs: [] })
      .on(ListAliasesCommand)
      .resolves({ Aliases: [{ AliasArn: aliasArn, Name: 'live' }] })
      .on(ListVersionsByFunctionCommand)
      .resolves({ Versions: [] });
    const ctx = {
      parent: { physicalId: 'my-fn', logicalId: 'Fn' },
      desired: {
        // The declared alias targets this function, but its FunctionName is UNRESOLVED
        // (e.g. an Fn::ImportValue with a degraded export). Its physical id IS the AliasArn.
        resources: [
          {
            resourceType: 'AWS::Lambda::Alias',
            physicalId: aliasArn,
            declared: { FunctionName: UNRESOLVED },
          },
        ],
        ctx: { liveAttrs: {} },
      },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateLambdaFunctionChildren(ctx);
    // Fail-safe: the declared alias must NOT be reported as an out-of-band addition.
    expect(added).toEqual([]);
    lambda.restore();
  });

  it('Lambda alias: a live alias with NO declared counterpart is still flagged added', async () => {
    // Guard against over-folding: the fail-safe must not suppress a genuine out-of-band alias.
    const rogueArn = 'arn:aws:lambda:us-east-1:111122223333:function:my-fn:rogue';
    const lambda = mockClient(LambdaClient);
    lambda
      .on(ListEventSourceMappingsCommand)
      .resolves({ EventSourceMappings: [] })
      .on(ListFunctionUrlConfigsCommand)
      .resolves({ FunctionUrlConfigs: [] })
      .on(ListAliasesCommand)
      .resolves({ Aliases: [{ AliasArn: rogueArn, Name: 'rogue' }] })
      .on(ListVersionsByFunctionCommand)
      .resolves({ Versions: [] });
    const ctx = {
      parent: { physicalId: 'my-fn', logicalId: 'Fn' },
      desired: { resources: [], ctx: { liveAttrs: {} } },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateLambdaFunctionChildren(ctx);
    expect(added.map((a) => a.identifier)).toEqual([rogueArn]);
    lambda.restore();
  });

  it('SNS subscription: an UNRESOLVED TopicArn is NOT flagged added (defect 2)', async () => {
    const subArn =
      'arn:aws:sns:us-east-1:111122223333:my-topic:00000000-1111-2222-3333-444444444444';
    const sns = mockClient(SNSClient);
    sns.on(ListSubscriptionsByTopicCommand).resolves({
      Subscriptions: [{ SubscriptionArn: subArn, Protocol: 'sqs', Endpoint: 'q' }],
    });
    const ctx = {
      parent: { physicalId: 'arn:aws:sns:us-east-1:111122223333:my-topic', logicalId: 'Topic' },
      desired: {
        // The declared subscription targets this topic, but its TopicArn is UNRESOLVED
        // (e.g. a `Ref` to a no-default Parameter). Its physical id IS the SubscriptionArn.
        resources: [
          {
            resourceType: 'AWS::SNS::Subscription',
            physicalId: subArn,
            declared: { TopicArn: UNRESOLVED },
          },
        ],
        ctx: { liveAttrs: {} },
      },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateSnsTopicChildren(ctx);
    expect(added).toEqual([]);
    sns.restore();
  });
});

describe('diffRoute53HostedZoneChildren (Route53 hosted zone record sets, #1042)', () => {
  const ZONE = 'Z1234567890ABC';
  const APEX = 'example.com';

  it('flags an out-of-band record (rogue CNAME/TXT) not in the template as `added`', () => {
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: APEX,
      declaredRecords: [{ name: 'www.example.com', type: 'A' }],
      liveRecords: [
        // AWS-auto-created apex records — must be filtered.
        { name: 'example.com.', type: 'SOA', live: { Name: 'example.com.', Type: 'SOA' } },
        { name: 'example.com.', type: 'NS', live: { Name: 'example.com.', Type: 'NS' } },
        // Declared record — must NOT be flagged.
        { name: 'www.example.com.', type: 'A', live: { Name: 'www.example.com.', Type: 'A' } },
        // Rogue out-of-band records — must be flagged.
        {
          name: 'login.example.com.',
          type: 'CNAME',
          live: {
            Name: 'login.example.com.',
            Type: 'CNAME',
            ResourceRecords: ['evil.example.net'],
          },
        },
        {
          name: '_verify.example.com.',
          type: 'TXT',
          live: { Name: '_verify.example.com.', Type: 'TXT' },
        },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Route53::RecordSet',
        identifier: `${ZONE}_login.example.com._CNAME`,
        label: 'CNAME login.example.com',
        live: {
          Name: 'login.example.com.',
          Type: 'CNAME',
          ResourceRecords: ['evil.example.net'],
        },
      },
      {
        resourceType: 'AWS::Route53::RecordSet',
        identifier: `${ZONE}__verify.example.com._TXT`,
        label: 'TXT _verify.example.com',
        live: { Name: '_verify.example.com.', Type: 'TXT' },
      },
    ]);
  });

  it('filters the apex SOA + apex NS, but KEEPS a non-apex NS delegation record', () => {
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: APEX,
      declaredRecords: [],
      liveRecords: [
        { name: 'example.com.', type: 'SOA', live: {} },
        { name: 'example.com.', type: 'NS', live: {} }, // apex NS -> filtered
        { name: 'sub.example.com.', type: 'NS', live: { Name: 'sub.example.com.', Type: 'NS' } }, // delegation -> kept
      ],
    });
    expect(added.map((a) => a.label)).toEqual(['NS sub.example.com']);
  });

  it('matches declared vs live dot- and case-insensitively (trailing-dot / case normalization)', () => {
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: APEX,
      // Template declares no trailing dot and mixed case; live is FQDN + AWS casing.
      declaredRecords: [{ name: 'WWW.Example.COM', type: 'a' }],
      liveRecords: [
        { name: 'www.example.com.', type: 'A', live: { Name: 'www.example.com.', Type: 'A' } },
      ],
    });
    expect(added).toEqual([]);
  });

  it('distinguishes weighted variants by SetIdentifier (one declared, one rogue)', () => {
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: APEX,
      declaredRecords: [{ name: 'api.example.com', type: 'A', setIdentifier: 'blue' }],
      liveRecords: [
        {
          name: 'api.example.com.',
          type: 'A',
          setIdentifier: 'blue',
          live: { Name: 'api.example.com.', Type: 'A' },
        },
        {
          name: 'api.example.com.',
          type: 'A',
          setIdentifier: 'green',
          live: { Name: 'api.example.com.', Type: 'A' },
        },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${ZONE}_api.example.com._A_green`]);
  });

  it('derives the apex from the live SOA when zoneApex is unresolved (still filters apex NS)', () => {
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: undefined,
      declaredRecords: [],
      liveRecords: [
        { name: 'example.com.', type: 'SOA', live: {} },
        { name: 'example.com.', type: 'NS', live: {} },
      ],
    });
    expect(added).toEqual([]);
  });
});

describe('enumerateRoute53HostedZoneChildren (#1042)', () => {
  it('pages ListResourceRecordSets, filters apex SOA/NS, flags a rogue record', async () => {
    const r53 = mockClient(Route53Client);
    r53
      .on(ListResourceRecordSetsCommand)
      .resolvesOnce({
        ResourceRecordSets: [
          { Name: 'example.com.', Type: 'SOA' },
          { Name: 'example.com.', Type: 'NS' },
          {
            Name: 'www.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '1.2.3.4' }],
          },
        ],
        IsTruncated: true,
        NextRecordName: 'z.example.com.',
        NextRecordType: 'A',
      })
      .resolves({
        ResourceRecordSets: [
          {
            Name: 'rogue.example.com.',
            Type: 'CNAME',
            TTL: 60,
            ResourceRecords: [{ Value: 'evil.net' }],
          },
        ],
        IsTruncated: false,
      });
    const ctx = {
      parent: {
        physicalId: 'Z1234567890ABC',
        logicalId: 'Zone',
        declared: { Name: 'example.com.' },
      },
      desired: {
        resources: [
          {
            resourceType: 'AWS::Route53::RecordSet',
            declared: { HostedZoneId: 'Z1234567890ABC', Name: 'www.example.com', Type: 'A' },
          },
        ],
        ctx: { liveAttrs: {} },
      },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateRoute53HostedZoneChildren(ctx);
    expect(added).toEqual([
      {
        resourceType: 'AWS::Route53::RecordSet',
        identifier: 'Z1234567890ABC_rogue.example.com._CNAME',
        label: 'CNAME rogue.example.com',
        live: {
          Name: 'rogue.example.com.',
          Type: 'CNAME',
          TTL: '60',
          ResourceRecords: ['evil.net'],
        },
      },
    ]);
    r53.restore();
  });

  it('fail-safe: a declared RecordSet with an UNRESOLVED HostedZoneId is NOT flagged added (#962)', async () => {
    const r53 = mockClient(Route53Client);
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: 'example.com.', Type: 'SOA' },
        { Name: 'example.com.', Type: 'NS' },
        { Name: 'www.example.com.', Type: 'A' },
      ],
      IsTruncated: false,
    });
    const ctx = {
      parent: {
        physicalId: 'Z1234567890ABC',
        logicalId: 'Zone',
        declared: { Name: 'example.com.' },
      },
      desired: {
        resources: [
          {
            resourceType: 'AWS::Route53::RecordSet',
            declared: { HostedZoneId: UNRESOLVED, Name: 'www.example.com', Type: 'A' },
          },
        ],
        ctx: { liveAttrs: {} },
      },
      region: 'us-east-1',
    } as unknown as EnumeratorContext;
    const added = await enumerateRoute53HostedZoneChildren(ctx);
    expect(added).toEqual([]);
    r53.restore();
  });
});

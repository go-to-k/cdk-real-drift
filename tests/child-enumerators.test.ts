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
import { ListSubscriptionsByTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import type { EnumeratorContext } from '../src/read/child-enumerators.js';
import {
  enumerateLambdaFunctionChildren,
  enumerateRdsClusterChildren,
  enumerateSnsTopicChildren,
  diffApiGatewayAuthorizers,
  diffApiGatewayChildren,
  diffApiGatewayGatewayResponses,
  diffApiGatewayModels,
  diffApiGatewayRequestValidators,
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
  diffRouteTableChildren,
  diffSnsTopicChildren,
  diffUserPoolChildren,
  diffUserPoolGroups,
  diffUserPoolResourceServers,
  diffVpcChildren,
  isBodyDefinedRestApi,
  isEnumerableRoute,
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
      },
    ]);
  });

  it('identifier is the bare rule Arn (CC primaryIdentifier)', () => {
    const added = diffEventBusChildren({
      declaredRuleNames: [],
      liveRules: [{ name: 'x', arn: R('x') }],
    });
    expect(added[0]!.identifier).toBe(R('x'));
  });

  it('no drift when every live rule is declared', () => {
    expect(
      diffEventBusChildren({
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
});

describe('diffUserPoolGroups (Cognito user pool groups)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  it('flags an out-of-band group added via the console (not in the template)', () => {
    const added = diffUserPoolGroups({
      userPoolId: POOL,
      declaredGroupNames: ['declared-group'],
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
      liveGroups: [{ name: 'group-x' }],
    });
    expect(added[0]!.identifier).toBe(`${POOL}|group-x`);
  });

  it('no drift when every live group is declared', () => {
    expect(
      diffUserPoolGroups({
        userPoolId: POOL,
        declaredGroupNames: ['a', 'b'],
        liveGroups: [{ name: 'a' }, { name: 'b' }],
      })
    ).toEqual([]);
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

    it('excludes an IPv6-only route (no DestinationCidrBlock)', () => {
      expect(
        isEnumerableRoute({
          DestinationIpv6CidrBlock: '::/0',
          Origin: 'CreateRoute',
          GatewayId: 'igw-123',
        })
      ).toBe(false);
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

import { describe, expect, it } from 'vite-plus/test';
import {
  diffApiGatewayChildren,
  diffApiGatewayV2Children,
  diffLambdaFunctionChildren,
  diffSnsTopicChildren,
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

import { describe, expect, it } from 'vite-plus/test';
import {
  diffApiGatewayChildren,
  diffApiGatewayV2Children,
  diffEventBusChildren,
  diffGraphQLApiChildren,
  diffLambdaFunctionChildren,
  diffLoadBalancerChildren,
  diffLogGroupChildren,
  diffSnsTopicChildren,
  diffUserPoolChildren,
  diffVpcChildren,
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

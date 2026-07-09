// #894 — DERIVED tier-2 folds promoting three formerly value-INDEPENDENT (tier-3) policy
// residues to equality gates computed from declared inputs, so a clean deploy stays atDefault
// while an out-of-band change to the value still surfaces (detection preserved):
//   - ApiGateway Stage CanarySetting.DeploymentId derived from the stage's own DeploymentId
//     (the canary is created pointed at the stage's current deployment). Previously folded
//     value-INDEPENDENT via GENERATED_NESTED_PATHS, hiding a canary re-point.
//   - EC2 VPCEndpoint DnsOptions derived from the declared VpcEndpointType (DnsRecordIpType
//     "ipv4" for Interface, "service-defined" for Gateway). Previously folded whole-object
//     value-INDEPENDENT via VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS.
// (Bedrock AgentAlias RoutingConfiguration stays value-independent by design — the auto-created
// agent version is a per-resource AWS-assigned value with no declared input to derive it from —
// so it has no classify.ts fold and is not asserted here.)
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId,
  declared,
});

describe('#894 ApiGateway Stage CanarySetting.DeploymentId derived from the stage DeploymentId', () => {
  const declared = {
    RestApiId: 'api1',
    StageName: 'prod',
    DeploymentId: 'dep-abc',
    CanarySetting: { PercentTraffic: 10, UseStageCache: false },
  };
  it('folds CanarySetting.DeploymentId to atDefault when it equals the stage DeploymentId', () => {
    const f = classifyResource(
      mk('AWS::ApiGateway::Stage', declared, 'prod'),
      {
        RestApiId: 'api1',
        StageName: 'prod',
        DeploymentId: 'dep-abc',
        CanarySetting: { PercentTraffic: 10, UseStageCache: false, DeploymentId: 'dep-abc' },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('CanarySetting.DeploymentId');
    expect(tier(f, 'undeclared')).not.toContain('CanarySetting.DeploymentId');
    expect(tier(f, 'generated')).not.toContain('CanarySetting.DeploymentId');
  });
  it('surfaces a canary re-pointed at a DIFFERENT deployment — detection preserved', () => {
    const f = classifyResource(
      mk('AWS::ApiGateway::Stage', declared, 'prod'),
      {
        RestApiId: 'api1',
        StageName: 'prod',
        DeploymentId: 'dep-abc',
        // Out-of-band `update-stage /canarySettings/deploymentId` to an OLD deployment.
        CanarySetting: { PercentTraffic: 10, UseStageCache: false, DeploymentId: 'dep-OLD' },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('CanarySetting.DeploymentId');
    expect(tier(f, 'atDefault')).not.toContain('CanarySetting.DeploymentId');
    expect(tier(f, 'generated')).not.toContain('CanarySetting.DeploymentId');
  });
  it('derives from the LIVE DeploymentId when the stage declares none', () => {
    const f = classifyResource(
      mk(
        'AWS::ApiGateway::Stage',
        { RestApiId: 'api1', StageName: 'prod', CanarySetting: {} },
        'p'
      ),
      {
        RestApiId: 'api1',
        StageName: 'prod',
        DeploymentId: 'dep-live',
        CanarySetting: { DeploymentId: 'dep-live' },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('CanarySetting.DeploymentId');
  });
});

describe('#894 EC2 VPCEndpoint DnsOptions derived from VpcEndpointType', () => {
  const dnsOptions = (dnsRecordIpType: string) => ({
    PrivateDnsOnlyForInboundResolverEndpoint: 'NotSpecified',
    PrivateDnsSpecifiedDomains: ['*'],
    DnsRecordIpType: dnsRecordIpType,
    PrivateDnsPreference: 'VERIFIED_DOMAINS_ONLY',
  });
  it('folds an Interface endpoint DnsOptions (DnsRecordIpType ipv4) to atDefault', () => {
    const f = classifyResource(
      mk('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface', ServiceName: 'svc' }, 'vpce-1'),
      { VpcEndpointType: 'Interface', ServiceName: 'svc', DnsOptions: dnsOptions('ipv4') },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('DnsOptions');
    expect(tier(f, 'undeclared')).not.toContain('DnsOptions');
  });
  it('folds a Gateway endpoint DnsOptions (DnsRecordIpType service-defined) to atDefault', () => {
    const f = classifyResource(
      mk('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway', ServiceName: 'svc' }, 'vpce-2'),
      {
        VpcEndpointType: 'Gateway',
        ServiceName: 'svc',
        DnsOptions: dnsOptions('service-defined'),
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('DnsOptions');
    expect(tier(f, 'undeclared')).not.toContain('DnsOptions');
  });
  it('surfaces an Interface endpoint whose DnsRecordIpType is flipped out of band — detection preserved', () => {
    const f = classifyResource(
      mk('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface', ServiceName: 'svc' }, 'vpce-1'),
      // Out-of-band ModifyVpcEndpoint flips DnsRecordIpType to dualstack.
      { VpcEndpointType: 'Interface', ServiceName: 'svc', DnsOptions: dnsOptions('dualstack') },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('DnsOptions');
    expect(tier(f, 'atDefault')).not.toContain('DnsOptions');
  });
  it('surfaces a changed non-DnsRecordIpType sub-key too (subset-tolerant equality gate)', () => {
    const f = classifyResource(
      mk('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface', ServiceName: 'svc' }, 'vpce-1'),
      {
        VpcEndpointType: 'Interface',
        ServiceName: 'svc',
        DnsOptions: {
          ...dnsOptions('ipv4'),
          PrivateDnsPreference: 'ALL_DOMAINS', // out-of-band change away from the default
        },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('DnsOptions');
  });
});

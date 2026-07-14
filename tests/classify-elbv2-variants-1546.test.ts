// #1546 — the ELBv2 defaults tables were built from the application/network +
// instance/ip/lambda axes only; a barest GWLB (GENEVE) target group, an ALB-behind-NLB
// (`TargetType: alb`) group, and TCP-family listeners first-ran 12 FPs (live-proven on
// CdkrdHunt0713bNetVariants, us-east-1, 2026-07-13; the out-of-band direction re-proven
// live: an idle-timeout 350->500 flip re-surfaced). Extends the #648 health-check
// derivation (GENEVE interval 10, alb-target timeout 6 + Matcher 200-399) and adds the
// per-Protocol / per-TargetType attribute-bag overrides + the TCP listener
// tcp.idle_timeout.seconds 350 default.
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

const attrs = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([Key, Value]) => ({ Key, Value }));

describe('#1546 GENEVE (GWLB) target group defaults', () => {
  const declared = {
    Protocol: 'GENEVE',
    Port: 6081,
    VpcId: 'vpc-0123456789abcdef0',
    TargetType: 'ip',
    HealthCheckProtocol: 'TCP',
    HealthCheckPort: '80',
  };
  const mk = (): DesiredResource => ({
    logicalId: 'HuntGeneveTg',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/geneve/abc',
    declared,
  });

  it('folds the GENEVE creation defaults (interval 10 + variant bag attrs) to atDefault', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        HealthCheckIntervalSeconds: 10,
        TargetGroupAttributes: attrs({
          'stickiness.type': 'source_ip_dest_ip_proto',
          'target_failover.on_deregistration': 'no_rebalance',
          'target_failover.on_unhealthy': 'no_rebalance',
        }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band failover-mode flip still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        TargetGroupAttributes: attrs({ 'target_failover.on_deregistration': 'rebalance' }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'TargetGroupAttributes[target_failover.on_deregistration]',
    ]);
  });
});

describe('#1546 alb-target (ALB behind NLB) target group defaults', () => {
  const declared = {
    Protocol: 'TCP',
    Port: 80,
    VpcId: 'vpc-0123456789abcdef0',
    TargetType: 'alb',
  };
  const mk = (): DesiredResource => ({
    logicalId: 'HuntAlbTg',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/albtg/abc',
    declared,
  });

  it('folds the alb-target creation defaults (timeout 6, Matcher 200-399, NLB-family bag attrs)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        HealthCheckTimeoutSeconds: 6,
        Matcher: { HttpCode: '200-399' },
        TargetGroupAttributes: attrs({
          'deregistration_delay.connection_termination.enabled': 'false',
          'preserve_client_ip.enabled': 'true',
          'proxy_protocol_v2.enabled': 'false',
          'stickiness.type': 'source_ip',
        }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an HTTP (ALB) group still folds the lb_cookie shared default, not the NLB override', () => {
    const httpDeclared = {
      Protocol: 'HTTP',
      Port: 80,
      VpcId: 'vpc-0123456789abcdef0',
      TargetType: 'instance',
    };
    const f = classifyResource(
      {
        logicalId: 'HttpTg',
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/http/abc',
        declared: httpDeclared,
      },
      { ...httpDeclared, TargetGroupAttributes: attrs({ 'stickiness.type': 'lb_cookie' }) },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

describe('#1546 TCP-family listener tcp.idle_timeout.seconds default', () => {
  const declared = {
    LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/net/n/1',
    Protocol: 'TCP',
    Port: 80,
    DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:tg' }],
  };
  const mk = (): DesiredResource => ({
    logicalId: 'HuntNlbListener',
    resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/net/n/1/2',
    declared,
  });

  it('folds the 350s creation default to atDefault', () => {
    const f = classifyResource(
      mk(),
      { ...declared, ListenerAttributes: attrs({ 'tcp.idle_timeout.seconds': '350' }) },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toContain('ListenerAttributes[tcp.idle_timeout.seconds]');
  });

  it('an out-of-band idle-timeout change still surfaces (live-proven 350->500)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, ListenerAttributes: attrs({ 'tcp.idle_timeout.seconds': '500' }) },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['ListenerAttributes[tcp.idle_timeout.seconds]']);
  });
});

// #1626 — the NLB-family extension of the same variant axis, live-proven on a barest
// TCP / ip-target group behind an internal NLB (attach-echo-hunt, us-east-1,
// 2026-07-14): the health check defaults to TCP with a 10s timeout (the KNOWN_DEFAULTS
// constants HTTP / 5 are the ALB-family values), the target_health_state.unhealthy.*
// bag pair returns at its defaults, and an ip-target group does NOT preserve client
// IPs (the inverse of the #1546 alb entry).
describe('#1626 TCP/ip-target NLB target group defaults', () => {
  const declared = {
    Protocol: 'TCP',
    Port: 80,
    VpcId: 'vpc-0123456789abcdef0',
    TargetType: 'ip',
  };
  const mk = (): DesiredResource => ({
    logicalId: 'AttachTg',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tcp/abc',
    declared,
  });
  const nlbDefaults = {
    HealthCheckProtocol: 'TCP',
    HealthCheckTimeoutSeconds: 10,
    TargetGroupAttributes: attrs({
      'preserve_client_ip.enabled': 'false',
      'target_health_state.unhealthy.connection_termination.enabled': 'true',
      'target_health_state.unhealthy.draining_interval_seconds': '0',
    }),
  };

  it('folds the TCP-family health-check + bag defaults to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(mk(), { ...declared, ...nlbDefaults }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toContain('HealthCheckProtocol');
    expect(pathsByTier(f, 'atDefault')).toContain('HealthCheckTimeoutSeconds');
  });

  it('an out-of-band health-check timeout change still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, ...nlbDefaults, HealthCheckTimeoutSeconds: 30 },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['HealthCheckTimeoutSeconds']);
  });

  it('an out-of-band preserve-client-ip ENABLE still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        ...nlbDefaults,
        TargetGroupAttributes: attrs({
          'preserve_client_ip.enabled': 'true',
          'target_health_state.unhealthy.connection_termination.enabled': 'true',
          'target_health_state.unhealthy.draining_interval_seconds': '0',
        }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'TargetGroupAttributes[preserve_client_ip.enabled]',
    ]);
  });

  it('an HTTP (ALB) group keeps the HTTP/5 constants — TCP/10 there is a real divergence', () => {
    const httpDeclared = { ...declared, Protocol: 'HTTP', TargetType: 'instance' };
    const f = classifyResource(
      { ...mk(), declared: httpDeclared },
      { ...httpDeclared, HealthCheckProtocol: 'HTTP', HealthCheckTimeoutSeconds: 5 },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

// #1626 — a barest VPCEndpointService reads back the ipv4-only creation default.
describe('#1626 VPCEndpointService SupportedIpAddressTypes default', () => {
  const declared = {
    NetworkLoadBalancerArns: [
      'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/net/nlb/abc',
    ],
    AcceptanceRequired: true,
  };
  const mk = (): DesiredResource => ({
    logicalId: 'AttachEpService',
    resourceType: 'AWS::EC2::VPCEndpointService',
    physicalId: 'vpce-svc-0123456789abcdef0',
    declared,
  });

  it('folds the undeclared ["ipv4"] to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SupportedIpAddressTypes: ['ipv4'] },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('SupportedIpAddressTypes');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a dualstack service still surfaces — detection preserved', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SupportedIpAddressTypes: ['ipv4', 'ipv6'] },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['SupportedIpAddressTypes']);
  });
});

// #1628 — the instance-target third arm of the preserve_client_ip axis, live-proven on a
// barest STANDALONE TCP/instance group (Cdkrd1623Writers, us-east-1, 2026-07-14): NLB-family
// instance targets default to PRESERVING client IPs ("true"), the inverse of the #1626
// ip-target entry.
describe('#1628 TCP/instance-target group preserve_client_ip default', () => {
  const declared = {
    Protocol: 'TCP',
    Port: 80,
    VpcId: 'vpc-0123456789abcdef0',
    TargetType: 'instance',
  };
  const mk = (): DesiredResource => ({
    logicalId: 'W1623InstanceTg',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/inst/abc',
    declared,
  });

  it('folds the instance-target "true" default to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        TargetGroupAttributes: attrs({ 'preserve_client_ip.enabled': 'true' }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band preserve-client-ip DISABLE still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        TargetGroupAttributes: attrs({ 'preserve_client_ip.enabled': 'false' }),
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'TargetGroupAttributes[preserve_client_ip.enabled]',
    ]);
  });
});

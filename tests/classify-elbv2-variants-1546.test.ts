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

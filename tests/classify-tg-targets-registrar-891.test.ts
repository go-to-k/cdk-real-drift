import { describe, expect, it } from 'vite-plus/test';
import { buildSiblingTargetGroupRegistrars } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #891 (SECURITY FN): AWS::ElasticLoadBalancingV2::TargetGroup `Targets` was folded `generated`
// VALUE-INDEPENDENT for EVERY group, so an out-of-band `elbv2 register-targets` — pointing a
// listener's production traffic at an attacker-controlled instance/IP — read CLEAN and survived
// record. The blanket fold is replaced with a TIER-2 sibling-derived registrar gate: a group into
// which a DECLARED sibling dynamically registers (an ECS Service, an ASG, or its own lambda
// TargetType) FOLDS its live membership; a NON-EMPTY membership on a group NO registrar explains
// SURFACES as [Potential Drift]. The registrar identities are built by
// gather.buildSiblingTargetGroupRegistrars and consumed in classify via
// opts.siblingTargetGroupRegistrars. An EMPTY live `Targets: []` is dropped either way (not a FP).

const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/1234567890abcdef';

const tgSchema: SchemaInfo = {
  readOnly: new Set([
    'TargetGroupArn',
    'TargetGroupName',
    'TargetGroupFullName',
    'LoadBalancerArns',
  ]),
  writeOnly: new Set([]),
  createOnly: new Set(['Name', 'Port', 'Protocol', 'ProtocolVersion', 'TargetType', 'VpcId']),
  readOnlyPaths: ['TargetGroupArn', 'TargetGroupName', 'TargetGroupFullName', 'LoadBalancerArns'],
  writeOnlyPaths: [],
  createOnlyPaths: ['Name', 'Port', 'Protocol', 'ProtocolVersion', 'TargetType', 'VpcId'],
  defaults: {},
  defaultPaths: {},
};

const tgResource = (declared: Record<string, unknown> = {}): DesiredResource => ({
  logicalId: 'Tg',
  resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
  physicalId: TG_ARN,
  declared,
});

// A group with a live non-empty registered membership (an undeclared Targets list).
const registeredLive = (): Record<string, unknown> => ({
  TargetGroupArn: TG_ARN,
  Targets: [{ Id: 'i-0abc123def4567890', Port: 80 }],
});

const targetsFindings = (findings: Finding[], tier: string) =>
  findings.filter((f) => f.tier === tier && f.path === 'Targets');

describe('#891 TargetGroup Targets sibling-derived registrar gate', () => {
  it('(map) marks a TG registered into by a declared ECS Service (LoadBalancers[].TargetGroupArn)', () => {
    const desired: Desired = {
      resources: [
        tgResource(),
        {
          logicalId: 'Svc',
          resourceType: 'AWS::ECS::Service',
          declared: {
            LoadBalancers: [
              { TargetGroupArn: { Ref: 'Tg' }, ContainerName: 'app', ContainerPort: 80 },
            ],
          },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(true);
    expect(map.has(TG_ARN)).toBe(true);
  });

  it('(map) marks a TG registered into by a declared ASG (TargetGroupARNs)', () => {
    const desired: Desired = {
      resources: [
        tgResource(),
        {
          logicalId: 'Asg',
          resourceType: 'AWS::AutoScaling::AutoScalingGroup',
          declared: { TargetGroupARNs: [{ Ref: 'Tg' }] },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(true);
    expect(map.has(TG_ARN)).toBe(true);
  });

  it('(map) marks a TG referenced by its resolved ARN string (not just {Ref})', () => {
    const desired: Desired = {
      resources: [
        tgResource(),
        {
          logicalId: 'Asg',
          resourceType: 'AWS::AutoScaling::AutoScalingGroup',
          declared: { TargetGroupARNs: [TG_ARN] },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(true);
    expect(map.has(TG_ARN)).toBe(true);
  });

  it('(map) marks a lambda-TargetType TG as its own registrar', () => {
    const desired: Desired = {
      resources: [tgResource({ TargetType: 'lambda' })],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(true);
    expect(map.has(TG_ARN)).toBe(true);
  });

  it('(map) a TG with NO registrar sibling is not marked', () => {
    const desired: Desired = {
      resources: [tgResource({ TargetType: 'instance' })],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(false);
    expect(map.has(TG_ARN)).toBe(false);
  });

  it('(map) a cross-stack Fn::ImportValue reference is skipped fail-open (not marked)', () => {
    const desired: Desired = {
      resources: [
        tgResource(),
        {
          logicalId: 'Svc',
          resourceType: 'AWS::ECS::Service',
          declared: {
            LoadBalancers: [{ TargetGroupArn: { 'Fn::ImportValue': 'OtherStack:TgArn' } }],
          },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingTargetGroupRegistrars(desired);
    expect(map.has('Tg')).toBe(false);
  });

  it('(1) a registrar-explained non-empty membership FOLDS (no Targets drift)', () => {
    // A declared ECS/ASG registrar (or lambda TargetType) owns the membership → folded generated.
    const siblingTargetGroupRegistrars = new Set(['Tg', TG_ARN]);
    const findings = classifyResource(tgResource(), registeredLive(), tgSchema, {
      siblingTargetGroupRegistrars,
    });
    expect(targetsFindings(findings, 'undeclared')).toEqual([]);
    expect(targetsFindings(findings, 'generated').length).toBe(1);
  });

  it('(2) a registrar-LESS non-empty membership SURFACES (the OOB register-targets hijack)', () => {
    // No declaring registrar → the live Targets membership is an out-of-band register-targets and
    // must surface as undeclared drift.
    const findings = classifyResource(tgResource(), registeredLive(), tgSchema, {
      siblingTargetGroupRegistrars: new Set<string>(),
    });
    const surfaced = targetsFindings(findings, 'undeclared');
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]?.actual).toEqual([{ Id: 'i-0abc123def4567890', Port: 80 }]);
  });

  it('(2b) with NO registrar map at all → a non-empty membership still SURFACES (fail-open to visible)', () => {
    const findings = classifyResource(tgResource(), registeredLive(), tgSchema);
    expect(targetsFindings(findings, 'undeclared').length).toBe(1);
  });

  it('(3) an EMPTY live Targets [] with no registrar produces NO finding (not a false undeclared)', () => {
    const live: Record<string, unknown> = { TargetGroupArn: TG_ARN, Targets: [] };
    const findings = classifyResource(tgResource(), live, tgSchema, {
      siblingTargetGroupRegistrars: new Set<string>(),
    });
    expect(findings.some((f) => f.path === 'Targets')).toBe(false);
  });

  it('(3b) an EMPTY live Targets [] WITH a registrar also produces no undeclared drift', () => {
    const live: Record<string, unknown> = { TargetGroupArn: TG_ARN, Targets: [] };
    const findings = classifyResource(tgResource(), live, tgSchema, {
      siblingTargetGroupRegistrars: new Set(['Tg', TG_ARN]),
    });
    expect(targetsFindings(findings, 'undeclared')).toEqual([]);
  });
});

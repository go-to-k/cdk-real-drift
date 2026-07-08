// #711 — first-run undeclared AWS-default constants surfacing as [Potential Drift] on a
// clean deploy of six raw-L1 types. All are stable service-default constants, folded as
// tier-1 equality-gated constants (KNOWN_DEFAULTS / KNOWN_DEFAULT_PATHS). Each test asserts
// the fold to atDefault AND, where meaningful, that a genuine divergence still surfaces.
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

describe('#711 Kinesis::Stream RetentionPeriodHours (equality-gated constant)', () => {
  const res = mk('AWS::Kinesis::Stream', { Name: 's', ShardCount: 1 });
  it('folds the 24h service default on a clean deploy', () => {
    const f = classifyResource(res, { RetentionPeriodHours: 24 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('RetentionPeriodHours');
    expect(tier(f, 'undeclared')).not.toContain('RetentionPeriodHours');
  });
  it('surfaces a longer retention out of band — detection preserved', () => {
    const f = classifyResource(res, { RetentionPeriodHours: 168 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('RetentionPeriodHours');
  });
});

describe('#711 Scheduler::Schedule State (equality-gated constant)', () => {
  const res = mk('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'rate(1 hour)',
    FlexibleTimeWindow: { Mode: 'OFF' },
  });
  it('folds the ENABLED service default on a clean deploy', () => {
    const f = classifyResource(res, { State: 'ENABLED' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('State');
    expect(tier(f, 'undeclared')).not.toContain('State');
  });
  it('surfaces an out-of-band DISABLED — detection preserved', () => {
    const f = classifyResource(res, { State: 'DISABLED' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('State');
  });
});

describe('#711 Route53::HealthCheck RequestInterval / FailureThreshold (nested constants)', () => {
  const res = mk('AWS::Route53::HealthCheck', {
    HealthCheckConfig: { Type: 'HTTP', FullyQualifiedDomainName: 'example.com' },
  });
  it('folds the 30s interval + 3-failure threshold defaults on a clean deploy', () => {
    const f = classifyResource(
      res,
      { HealthCheckConfig: { RequestInterval: 30, FailureThreshold: 3 } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining([
        'HealthCheckConfig.RequestInterval',
        'HealthCheckConfig.FailureThreshold',
      ])
    );
    expect(tier(f, 'undeclared')).not.toContain('HealthCheckConfig.RequestInterval');
    expect(tier(f, 'undeclared')).not.toContain('HealthCheckConfig.FailureThreshold');
  });
  it('surfaces an out-of-band interval/threshold change — detection preserved', () => {
    const f = classifyResource(
      res,
      { HealthCheckConfig: { RequestInterval: 10, FailureThreshold: 5 } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual(
      expect.arrayContaining([
        'HealthCheckConfig.RequestInterval',
        'HealthCheckConfig.FailureThreshold',
      ])
    );
  });
});

describe('#711 ECS::TaskDefinition ContainerDefinitions[*].Essential (nested constant)', () => {
  const res = mk('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [{ Name: 'c', Image: 'nginx' }],
  });
  // The nested finding path is keyed by the container's identity field (Name = "c"),
  // i.e. `ContainerDefinitions[c].Essential`, not a numeric index.
  it('folds the Essential: true service default on a clean deploy', () => {
    const f = classifyResource(
      res,
      { ContainerDefinitions: [{ Name: 'c', Image: 'nginx', Essential: true }] },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('ContainerDefinitions[c].Essential');
    expect(tier(f, 'undeclared')).not.toContain('ContainerDefinitions[c].Essential');
  });
  // Detection note: the only non-default value is Essential: false, which is
  // structurally trivial-empty (isTrivialEmpty(false) === true), so an UNDECLARED
  // Essential: false never surfaces regardless of this fold — a pre-existing
  // trivial-false concern that is out of scope for #711 and not expressible in
  // noise.ts. When the user DECLARES Essential, it is compared in the declared
  // dimension and this fold does not touch it (verified below).
  it('does NOT fold a DECLARED Essential that differs from live (declared-dimension compare)', () => {
    const declaredRes = mk('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{ Name: 'c', Image: 'nginx', Essential: true }],
    });
    const f = classifyResource(
      declaredRes,
      { ContainerDefinitions: [{ Name: 'c', Image: 'nginx', Essential: false }] },
      emptySchema
    );
    // a declared Essential:true whose live value is false is real declared drift,
    // not silently folded to atDefault by the KNOWN_DEFAULT_PATHS entry. (The declared
    // dimension reports the numeric-index path form.)
    expect(tier(f, 'atDefault')).not.toContain('ContainerDefinitions.0.Essential');
    expect(tier(f, 'declared')).toContain('ContainerDefinitions.0.Essential');
  });
});

describe('#711 EC2::VPCEndpoint VpcEndpointType (equality-gated constant)', () => {
  const res = mk('AWS::EC2::VPCEndpoint', {
    ServiceName: 'com.amazonaws.us-east-1.s3',
    VpcId: 'vpc-1',
  });
  it('folds the Gateway service default on a clean deploy', () => {
    const f = classifyResource(res, { VpcEndpointType: 'Gateway' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('VpcEndpointType');
    expect(tier(f, 'undeclared')).not.toContain('VpcEndpointType');
  });
});

describe('#711 Logs::AccountPolicy Scope (equality-gated constant)', () => {
  const res = mk('AWS::Logs::AccountPolicy', {
    PolicyName: 'p',
    PolicyType: 'DATA_PROTECTION_POLICY',
    PolicyDocument: '{}',
  });
  it('folds the ALL service default on a clean deploy', () => {
    const f = classifyResource(res, { Scope: 'ALL' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Scope');
    expect(tier(f, 'undeclared')).not.toContain('Scope');
  });
  it('surfaces an out-of-band scope change — detection preserved', () => {
    const f = classifyResource(res, { Scope: 'SOME_SELECTION' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('Scope');
  });
});

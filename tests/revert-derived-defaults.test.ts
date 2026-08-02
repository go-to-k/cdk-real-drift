// #1709/#1710 (hunt 2026-08-02): derived-default revert convergence.
//
// classify computes tier-2 DERIVED defaults into its local knownDef/knownDefPaths, so the
// revert planner used to have no value source for them: the bare `remove` it fell back to
// was a live-proven silent no-op (Route53 HealthCheck Port, the ELBv2 TargetGroup
// health-check pair), and for the RDS replica BackupRetentionPeriod the STATIC
// KNOWN_DEFAULTS 1 shadowed the derived 0 — a wrong-value revert. The plan now derives
// through the shared normalize/derived-defaults.js helpers (an explicit `add` of the
// derived value) and carries #1710 companion removes where the naive add is rejected by
// an incompatible sibling echo. Every expectation here mirrors a stackless CC probe.
import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const F = (over: Partial<Finding>): Finding => ({
  tier: 'undeclared',
  logicalId: 'R',
  physicalId: 'phys-1',
  resourceType: 'AWS::Route53::HealthCheck',
  path: 'HealthCheckConfig.Port',
  ...over,
});

const planOne = (
  finding: Finding,
  declared: Record<string, unknown> | undefined,
  live?: Record<string, unknown>
) =>
  buildRevertPlan([finding], undefined, {
    removeUnrecorded: true,
    declaredForLogical: () => declared,
    ...(live ? { liveByLogical: new Map([['R', live]]) } : {}),
  });

describe('derived-default revert route (#1709)', () => {
  it('Route53 HealthCheck Port reverts to the type-derived 80 (HTTP), not a bare remove', () => {
    const plan = planOne(F({ actual: 8080 }), {
      HealthCheckConfig: { Type: 'HTTP', FullyQualifiedDomainName: 'example.com' },
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/HealthCheckConfig/Port', value: 80 }),
    ]);
  });

  it('Route53 HealthCheck Port derives 443 for the HTTPS pair', () => {
    const plan = planOne(F({ actual: 8443 }), { HealthCheckConfig: { Type: 'HTTPS_STR_MATCH' } });
    expect(plan.items[0]?.ops[0]).toMatchObject({ op: 'add', value: 443 });
  });

  it('Route53 HealthCheck Port on a TCP check has no derivation and keeps the remove', () => {
    const plan = planOne(F({ actual: 8080 }), { HealthCheckConfig: { Type: 'TCP' } });
    expect(plan.items[0]?.ops[0]).toMatchObject({ op: 'remove' });
  });

  it('without declaredForLogical the derived route is skipped (fail-safe remove)', () => {
    const plan = buildRevertPlan([F({ actual: 8080 })], undefined, { removeUnrecorded: true });
    expect(plan.items[0]?.ops[0]).toMatchObject({ op: 'remove' });
  });

  it('RDS replica BackupRetentionPeriod reverts to the DERIVED 0, not the static 1', () => {
    const plan = planOne(
      F({
        resourceType: 'AWS::RDS::DBInstance',
        path: 'BackupRetentionPeriod',
        actual: 3,
      }),
      { SourceDBInstanceIdentifier: 'source-db', DBInstanceClass: 'db.t4g.micro' }
    );
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/BackupRetentionPeriod', value: 0 }),
    ]);
  });

  it('non-replica RDS BackupRetentionPeriod keeps the static RSDP value 1', () => {
    const plan = planOne(
      F({ resourceType: 'AWS::RDS::DBInstance', path: 'BackupRetentionPeriod', actual: 3 }),
      { DBInstanceClass: 'db.t4g.micro' }
    );
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/BackupRetentionPeriod', value: 1 }),
    ]);
  });
});

describe('companion removes (#1710)', () => {
  it('GENEVE TargetGroup HC protocol reverts to TCP with the L7 echoes removed', () => {
    const plan = planOne(
      F({
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        path: 'HealthCheckProtocol',
        actual: 'HTTP',
      }),
      { Protocol: 'GENEVE', Port: 6081, VpcId: 'vpc-1', TargetType: 'instance' },
      { HealthCheckProtocol: 'HTTP', Matcher: { HttpCode: '200' }, HealthCheckPath: '/' }
    );
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/HealthCheckProtocol', value: 'TCP' }),
      expect.objectContaining({ op: 'remove', path: '/Matcher' }),
      expect.objectContaining({ op: 'remove', path: '/HealthCheckPath' }),
    ]);
  });

  it('GENEVE TargetGroup HC port reverts to the derived fixed 80', () => {
    const plan = planOne(
      F({
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        path: 'HealthCheckPort',
        actual: '8080',
      }),
      { Protocol: 'GENEVE', TargetType: 'instance' }
    );
    expect(plan.items[0]?.ops[0]).toMatchObject({ op: 'add', value: '80' });
  });

  it('HTTPS TargetGroup HC protocol reverts to HTTPS with NO companions (L7-to-L7)', () => {
    const plan = planOne(
      F({
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        path: 'HealthCheckProtocol',
        actual: 'HTTP',
      }),
      { Protocol: 'HTTPS', TargetType: 'instance' },
      { HealthCheckProtocol: 'HTTP', Matcher: { HttpCode: '200' }, HealthCheckPath: '/' }
    );
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/HealthCheckProtocol', value: 'HTTPS' }),
    ]);
  });

  it('Volume VolumeType reverts to gp2 with the gp3 provisioning echoes removed', () => {
    const plan = planOne(
      F({ resourceType: 'AWS::EC2::Volume', path: 'VolumeType', actual: 'gp3' }),
      { AvailabilityZone: 'us-east-1a', Size: 1 },
      { VolumeType: 'gp3', Iops: 3000, Throughput: 125, Size: 1 }
    );
    expect(plan.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/VolumeType', value: 'gp2' }),
      expect.objectContaining({ op: 'remove', path: '/Iops' }),
      expect.objectContaining({ op: 'remove', path: '/Throughput' }),
    ]);
  });

  it('companion removes are gated on live presence and on the sibling being undeclared', () => {
    // Throughput absent from live (an sc1 drift shape) -> only the present Iops is removed;
    // a DECLARED Iops is never stripped even when present live.
    const planAbsent = planOne(
      F({ resourceType: 'AWS::EC2::Volume', path: 'VolumeType', actual: 'sc1' }),
      { AvailabilityZone: 'us-east-1a', Size: 1 },
      { VolumeType: 'sc1', Size: 1 }
    );
    expect(planAbsent.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/VolumeType', value: 'gp2' }),
    ]);
    const planDeclared = planOne(
      F({ resourceType: 'AWS::EC2::Volume', path: 'VolumeType', actual: 'gp3' }),
      { AvailabilityZone: 'us-east-1a', Size: 1, Iops: 4000 },
      { VolumeType: 'gp3', Iops: 4000, Throughput: 125 }
    );
    expect(planDeclared.items[0]?.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/VolumeType', value: 'gp2' }),
      expect.objectContaining({ op: 'remove', path: '/Throughput' }),
    ]);
  });
});

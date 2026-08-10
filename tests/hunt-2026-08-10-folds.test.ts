// 2026-08-10 hunt regressions:
//  - #1740: ECS DAEMON scheduling — the rollout band derives 100/0 (not the REPLICA
//    200/100 pins) and DesiredCount is ECS-managed (value-independent for DAEMON).
//  - #1741: RDS stores engine names / parameter-group families lowercased while the
//    CFn handlers accept mixed case — declared-side case tolerance.
//  - #1742: Route53 RecordSetGroup members are template-declared records — the zone
//    child-enumerator must not flag them `added`.
//  - #1745: an undeclared ELB attribute-bag element reverts via the per-key prop
//    writer (attributeKey) with the recorded/curated value — not `notRevertable`.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { collectEbSecurityGroupIds } from '../src/commands/gather.js';
import { ebOptionSettingTier } from '../src/normalize/noise.js';
import { collectDeclaredRoute53Records } from '../src/read/child-enumerators.js';
import { buildRevertPlan } from '../src/revert/plan.js';
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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

// The full DAEMON-band echo captured live (variants6-hunt corpus, 2026-08-10).
const DAEMON_DEPLOYMENT_CONFIGURATION = {
  BakeTimeInMinutes: 0,
  Strategy: 'ROLLING',
  DeploymentCircuitBreaker: {
    ThresholdConfiguration: { Type: 'BOUNDED_PERCENT', Value: 50 },
    Enable: false,
    ResetOnHealthyTask: true,
    Rollback: false,
  },
  MaximumPercent: 100,
  MinimumHealthyPercent: 0,
};

describe('#1740 ECS DAEMON scheduling variant', () => {
  const daemonService = (): DesiredResource => ({
    logicalId: 'DaemonService',
    resourceType: 'AWS::ECS::Service',
    physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/daemon-svc',
    declared: {
      Cluster: 'c',
      TaskDefinition: 'td:1',
      LaunchType: 'EC2',
      SchedulingStrategy: 'DAEMON',
    },
  });

  it('folds the DAEMON rollout band + ECS-managed DesiredCount on a clean first run', () => {
    const findings = classifyResource(
      daemonService(),
      {
        Cluster: 'c',
        TaskDefinition: 'td:1',
        LaunchType: 'EC2',
        SchedulingStrategy: 'DAEMON',
        DesiredCount: 0,
        DeploymentConfiguration: DAEMON_DEPLOYMENT_CONFIGURATION,
      },
      emptySchema
    );
    // the FULL tier:path list — nothing may surface as undeclared/declared
    expect(tierPaths(findings)).toEqual([
      'atDefault:DeploymentConfiguration',
      'atDefault:DesiredCount',
    ]);
  });

  it('DesiredCount folds value-independently for DAEMON (ECS moves it with the fleet)', () => {
    const findings = classifyResource(
      daemonService(),
      {
        Cluster: 'c',
        TaskDefinition: 'td:1',
        LaunchType: 'EC2',
        SchedulingStrategy: 'DAEMON',
        DesiredCount: 7,
      },
      emptySchema
    );
    expect(tierPaths(findings)).toEqual(['atDefault:DesiredCount']);
  });

  it('an out-of-band DAEMON band change still surfaces (equality gate preserved)', () => {
    const findings = classifyResource(
      daemonService(),
      {
        Cluster: 'c',
        TaskDefinition: 'td:1',
        LaunchType: 'EC2',
        SchedulingStrategy: 'DAEMON',
        DeploymentConfiguration: {
          ...DAEMON_DEPLOYMENT_CONFIGURATION,
          MinimumHealthyPercent: 50,
        },
      },
      emptySchema
    );
    // the changed band no longer matches the derived whole-object pin, so it SURFACES
    // (as the whole object or the leaf — either way detection is preserved, never folded)
    const surfaced = findings.filter(
      (f) => f.tier === 'undeclared' && f.path.startsWith('DeploymentConfiguration')
    );
    expect(surfaced.length).toBeGreaterThan(0);
  });

  it('a REPLICA service still folds the 200/100 band (static pins untouched)', () => {
    const findings = classifyResource(
      {
        logicalId: 'Replica',
        resourceType: 'AWS::ECS::Service',
        physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/replica-svc',
        declared: { Cluster: 'c', TaskDefinition: 'td:1', DesiredCount: 1 },
      },
      {
        Cluster: 'c',
        TaskDefinition: 'td:1',
        DesiredCount: 1,
        SchedulingStrategy: 'REPLICA',
        DeploymentConfiguration: {
          ...DAEMON_DEPLOYMENT_CONFIGURATION,
          MaximumPercent: 200,
          MinimumHealthyPercent: 100,
        },
      },
      emptySchema
    );
    expect(tierPaths(findings)).toEqual([
      'atDefault:DeploymentConfiguration',
      'atDefault:SchedulingStrategy',
    ]);
  });

  it('reverting a DAEMON band leaf writes the DERIVED 100/0 explicitly (not the REPLICA 200/100)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'DaemonService',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/daemon-svc',
      path: 'DeploymentConfiguration.MinimumHealthyPercent',
      actual: 50,
      nested: true,
    };
    const plan = buildRevertPlan([f], undefined, {
      declaredForLogical: () => ({ SchedulingStrategy: 'DAEMON' }),
    });
    expect(plan.notRevertable).toEqual([]);
    const op = plan.items[0]!.ops[0]!;
    expect(op.op).toBe('add');
    expect(op.value).toBe(0);
  });
});

describe('#1741 RDS mixed-case Engine/EngineName/Family declared echoes fold', () => {
  const CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      'AWS::RDS::OptionGroup',
      { OptionGroupName: 'og', EngineName: 'MySQL', MajorEngineVersion: '8.4' },
      { OptionGroupName: 'og', EngineName: 'mysql', MajorEngineVersion: '8.4' },
    ],
    [
      'AWS::RDS::DBParameterGroup',
      { DBParameterGroupName: 'pg', Family: 'MySQL8.4', Description: 'd' },
      { DBParameterGroupName: 'pg', Family: 'mysql8.4', Description: 'd' },
    ],
    [
      'AWS::RDS::DBClusterParameterGroup',
      { DBClusterParameterGroupName: 'cpg', Family: 'Aurora-MySQL8.0', Description: 'd' },
      { DBClusterParameterGroupName: 'cpg', Family: 'aurora-mysql8.0', Description: 'd' },
    ],
    [
      'AWS::RDS::DBInstance',
      { DBInstanceIdentifier: 'db', Engine: 'MySQL', DBInstanceClass: 'db.t3.micro' },
      { DBInstanceIdentifier: 'db', Engine: 'mysql', DBInstanceClass: 'db.t3.micro' },
    ],
    [
      'AWS::RDS::DBCluster',
      { DBClusterIdentifier: 'cl', Engine: 'Aurora-MySQL' },
      { DBClusterIdentifier: 'cl', Engine: 'aurora-mysql' },
    ],
  ];
  for (const [type, declared, live] of CASES) {
    it(`${type}: case-only echo folds`, () => {
      const findings = classifyResource(
        { logicalId: 'R', resourceType: type, physicalId: 'r', declared },
        live,
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    });
  }

  it('a real engine change (beyond case) still surfaces', () => {
    const findings = classifyResource(
      {
        logicalId: 'R',
        resourceType: 'AWS::RDS::OptionGroup',
        physicalId: 'og',
        declared: { OptionGroupName: 'og', EngineName: 'MySQL', MajorEngineVersion: '8.4' },
      },
      { OptionGroupName: 'og', EngineName: 'postgres', MajorEngineVersion: '8.4' },
      emptySchema
    );
    expect(findings.filter((f) => f.tier === 'declared').map((f) => f.path)).toEqual([
      'EngineName',
    ]);
  });
});

describe('#1742 RecordSetGroup members are declared records', () => {
  const ZONE = 'Z123EXAMPLE';
  it('collects group members via the group-level zone ref', () => {
    const declared = collectDeclaredRoute53Records(
      [
        {
          resourceType: 'AWS::Route53::RecordSetGroup',
          declared: {
            HostedZoneId: ZONE,
            RecordSets: [
              { Name: 'MiXeD-Case.example-hunt.com', Type: 'A', TTL: '300' },
              { Name: 'txt.example-hunt.com.', Type: 'TXT', SetIdentifier: 'x' },
            ],
          },
        },
      ],
      ZONE,
      'example-hunt.com.'
    );
    expect(declared).toEqual([
      { name: 'MiXeD-Case.example-hunt.com', type: 'A', setIdentifier: undefined },
      { name: 'txt.example-hunt.com.', type: 'TXT', setIdentifier: 'x' },
    ]);
  });

  it('honors a per-member zone ref and skips members of OTHER zones', () => {
    const declared = collectDeclaredRoute53Records(
      [
        {
          resourceType: 'AWS::Route53::RecordSetGroup',
          declared: {
            RecordSets: [
              { Name: 'a.example-hunt.com', Type: 'A', HostedZoneId: ZONE },
              { Name: 'b.other.com', Type: 'A', HostedZoneId: 'ZOTHER' },
            ],
          },
        },
      ],
      ZONE,
      'example-hunt.com.'
    );
    expect(declared).toEqual([{ name: 'a.example-hunt.com', type: 'A', setIdentifier: undefined }]);
  });

  it('standalone RecordSet collection is unchanged', () => {
    const declared = collectDeclaredRoute53Records(
      [
        {
          resourceType: 'AWS::Route53::RecordSet',
          declared: { HostedZoneId: ZONE, Name: 'solo.example-hunt.com', Type: 'CNAME' },
        },
      ],
      ZONE,
      'example-hunt.com.'
    );
    expect(declared).toEqual([
      { name: 'solo.example-hunt.com', type: 'CNAME', setIdentifier: undefined },
    ]);
  });
});

describe('#1745 undeclared ELB attribute-bag element reverts via the per-key writer', () => {
  const tgFinding = (over: Partial<Finding> = {}): Finding => ({
    tier: 'undeclared',
    logicalId: 'Tg',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/abc',
    path: 'TargetGroupAttributes[deregistration_delay.timeout_seconds]',
    actual: '45',
    nested: true,
    ...over,
  });

  it('appeared-since-record: writes the curated per-key default via attributeKey', () => {
    const plan = buildRevertPlan([tgFinding()], undefined, {
      declaredForLogical: () => ({ Protocol: 'TCP', TargetType: 'instance' }),
    });
    expect(plan.notRevertable).toEqual([]);
    const item = plan.items[0]!;
    expect(item.kind).toBe('sdk');
    const op = item.ops[0]!;
    expect(op.attributeKey).toBe('deregistration_delay.timeout_seconds');
    expect(op.value).toBe('300');
  });

  it('recorded-then-changed: restores the baseline value', () => {
    const plan = buildRevertPlan(
      [tgFinding()],
      {
        recorded: [
          {
            logicalId: 'Tg',
            path: 'TargetGroupAttributes[deregistration_delay.timeout_seconds]',
            value: '120',
          },
        ],
      } as never,
      { declaredForLogical: () => ({ Protocol: 'TCP', TargetType: 'instance' }) }
    );
    expect(plan.notRevertable).toEqual([]);
    expect(plan.items[0]!.ops[0]!.value).toBe('120');
  });

  it('a bag with NO per-key writer (ListenerAttributes) stays honestly not-revertable', () => {
    const plan = buildRevertPlan(
      [
        tgFinding({
          logicalId: 'L',
          resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
          path: 'ListenerAttributes[tcp.idle_timeout.seconds]',
          actual: '400',
        }),
      ],
      undefined,
      {}
    );
    expect(plan.items).toEqual([]);
    expect(plan.notRevertable.map((n) => n.path)).toEqual([
      'ListenerAttributes[tcp.idle_timeout.seconds]',
    ]);
  });

  it('an unknown key with no curated default stays honestly not-revertable', () => {
    const plan = buildRevertPlan(
      [tgFinding({ path: 'TargetGroupAttributes[custom.attribute.nobody.knows]' })],
      undefined,
      { declaredForLogical: () => ({ Protocol: 'TCP', TargetType: 'instance' }) }
    );
    expect(plan.items).toEqual([]);
    expect(plan.notRevertable).toHaveLength(1);
  });
});

describe('#1746 EB SecurityGroups raw sg-id echo resolves through the anchored gate', () => {
  const SG_ID = 'sg-08ffdc7eb70b6418a';
  const tier = (sgNamesById?: Readonly<Record<string, string>>) =>
    ebOptionSettingTier(
      'aws:elb:loadbalancer',
      'SecurityGroups',
      SG_ID,
      'LoadBalanced',
      undefined,
      sgNamesById
    );

  it('folds when the id resolves to the environment-generated group name', () => {
    expect(tier({ [SG_ID]: 'awseb-e-abc123-stack-AWSEBLoadBalancerSecurityGroup-1A2B3C' })).toBe(
      'atDefault'
    );
  });
  it('surfaces when the id resolves to a NON-generated (rogue) group name', () => {
    expect(tier({ [SG_ID]: 'my-rogue-group' })).toBe('undeclared');
  });
  it('surfaces when the id cannot be resolved (fail-closed, the #1264 posture)', () => {
    expect(tier(undefined)).toBe('undeclared');
    expect(tier({})).toBe('undeclared');
  });
  it('generated NAMES still fold without any map (existing behavior)', () => {
    expect(
      ebOptionSettingTier(
        'aws:autoscaling:launchconfiguration',
        'SecurityGroups',
        'awseb-e-abc123-stack-AWSEBSecurityGroup-XYZ',
        'LoadBalanced'
      )
    ).toBe('atDefault');
  });

  it('collectEbSecurityGroupIds extracts ids from EB env SecurityGroups options only', () => {
    const ids = collectEbSecurityGroupIds(
      [
        { logicalId: 'EbEnv', resourceType: 'AWS::ElasticBeanstalk::Environment' },
        { logicalId: 'Other', resourceType: 'AWS::S3::Bucket' },
      ],
      new Map([
        [
          'EbEnv',
          {
            OptionSettings: [
              {
                Namespace: 'aws:elb:loadbalancer',
                OptionName: 'SecurityGroups',
                Value: `${SG_ID},awseb-e-abc-stack-AWSEBSecurityGroup-X`,
              },
              { Namespace: 'aws:elb:loadbalancer', OptionName: 'CrossZone', Value: 'sg-deadbeef' },
            ],
          },
        ],
      ])
    );
    expect(ids).toEqual([SG_ID]);
  });
});

describe('#1740 DAEMON whole-object DeploymentConfiguration revert', () => {
  it('writes the derived DAEMON object explicitly + companion-removes the DesiredCount echo', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'DaemonService',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/daemon-svc',
      path: 'DeploymentConfiguration',
      actual: { MaximumPercent: 100, MinimumHealthyPercent: 50 },
    };
    const plan = buildRevertPlan([f], undefined, {
      declaredForLogical: () => ({ SchedulingStrategy: 'DAEMON' }),
      liveByLogical: new Map([
        ['DaemonService', { DesiredCount: 3, DeploymentConfiguration: f.actual }],
      ]) as never,
    });
    expect(plan.notRevertable).toEqual([]);
    const ops = plan.items[0]!.ops;
    const add = ops.find((o) => o.path === '/DeploymentConfiguration')!;
    expect(add.op).toBe('add');
    expect((add.value as Record<string, unknown>).MaximumPercent).toBe(100);
    expect((add.value as Record<string, unknown>).MinimumHealthyPercent).toBe(0);
    // the ECS-managed DesiredCount echo rides the same patch as a remove — the DAEMON
    // validation rejects any model that still carries it (live, variants6-hunt). It is a
    // CONTRACT op: the echo persists by design after the revert, so the convergence no-op
    // detector must skip it (a non-contract companion false-flagged "NOT reverted" live).
    const companion = ops.find((o) => o.op === 'remove' && o.path === '/DesiredCount');
    expect(companion).toBeDefined();
    expect(companion!.contract).toBe(true);
  });

  it('a REPLICA service reverting DeploymentConfiguration keeps its DECLARED DesiredCount', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/svc',
      path: 'DeploymentConfiguration',
      actual: { MaximumPercent: 150 },
    };
    const plan = buildRevertPlan([f], undefined, {
      declaredForLogical: () => ({ DesiredCount: 2 }),
      liveByLogical: new Map([['Svc', { DesiredCount: 2 }]]) as never,
    });
    const ops = plan.items[0]!.ops;
    expect(ops.some((o) => o.op === 'remove' && o.path === '/DesiredCount')).toBe(false);
  });
});

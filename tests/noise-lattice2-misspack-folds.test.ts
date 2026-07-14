// 2026-07-15 hunt (lattice2-hunt + misspack-hunt fixtures): eleven first-run FPs on a
// barest VPC Lattice family stack and a barest missing-type pack, all live-verified
// (base binary surfaced each as [Potential Drift]; fixed binary first-checks CLEAN).
// - VpcLattice AccessLogSubscription.ServiceNetworkLogType = SERVICE (constant)
// - VpcLattice ResourceGateway IpAddressType/Ipv4AddressesPerEni/
//   ResourceConfigDnsResolution (constants; not OOB-mutable — update-resource-gateway
//   accepts only --security-group-ids) + SecurityGroupIds = VPC default SG (the #976
//   derived DEFAULT_SG_LIST gate)
// - VpcLattice ResourceConfiguration.AllowAssociationToSharableServiceNetwork = true
//   (truthy standalone bool → paired MEANINGFUL_WHEN_OFF entry; the off-flip was
//   live-proven to surface and to need a REVERT_SET_DEFAULT_PATHS entry)
// - VpcLattice ServiceNetwork.Name: CFn mints the generated name LOWERCASED
//   ("cdkrdhunt0715lattice-sn-f6xaf7zc2alb" for stack CdkrdHunt0715Lattice, logical id
//   Sn) because lattice names must be lowercase — isCfnGeneratedName's exact-case
//   comparisons missed it (now case-insensitive on the dash forms)
// - SES DedicatedIpPool.ScalingMode = STANDARD (constant)
// - Backup RestoreTestingPlan StartWindowHours=24 / ScheduleExpressionTimezone=Etc/UTC
//   (top-level constants) + RecoveryPointSelection.SelectionWindowDays=30 (nested)
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

describe('VpcLattice AccessLogSubscription first-run folds (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'SnAls',
    resourceType: 'AWS::VpcLattice::AccessLogSubscription',
    physicalId: 'arn:aws:vpc-lattice:us-east-1:111111111111:accesslogsubscription/als-x',
    declared: {
      ResourceIdentifier: 'sn-035847d35c755a015',
      DestinationArn: 'arn:aws:logs:us-east-1:111111111111:log-group:g',
    },
  };

  it('folds the undeclared SERVICE log type to atDefault', () => {
    const f = classifyResource(
      res,
      { ...res.declared, ServiceNetworkLogType: 'SERVICE' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('ServiceNetworkLogType');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces a RESOURCE log type (not the default)', () => {
    const f = classifyResource(
      res,
      { ...res.declared, ServiceNetworkLogType: 'RESOURCE' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['ServiceNetworkLogType']);
  });
});

describe('VpcLattice ResourceGateway first-run folds (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'Rg',
    resourceType: 'AWS::VpcLattice::ResourceGateway',
    physicalId: 'rgw-062fc1eeaf119a6f6',
    declared: {
      Name: 'cdkrd-hunt-0715-rg',
      VpcIdentifier: 'vpc-1234567890abcdef0',
      SubnetIds: ['subnet-1234567890abcdef0'],
    },
  };
  const live = (over: Record<string, unknown> = {}) => ({
    ...res.declared,
    IpAddressType: 'IPV4',
    Ipv4AddressesPerEni: 16,
    ResourceConfigDnsResolution: 'PUBLIC',
    SecurityGroupIds: ['sg-0722af66254639599'],
    ...over,
  });
  const opts = { defaultSgIds: new Set(['sg-0722af66254639599']) };

  it('folds the clean-deploy read (3 constants + VPC default SG) — first run is CLEAN', () => {
    const f = classifyResource(res, live(), emptySchema, opts);
    expect(pathsByTier(f, 'atDefault')).toEqual([
      'IpAddressType',
      'Ipv4AddressesPerEni',
      'ResourceConfigDnsResolution',
      'SecurityGroupIds',
    ]);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces a non-default value on each constant', () => {
    const f = classifyResource(
      res,
      live({ IpAddressType: 'DUALSTACK', Ipv4AddressesPerEni: 4 }),
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['IpAddressType', 'Ipv4AddressesPerEni']);
  });

  it('surfaces an out-of-band SG swap/append (the derived gate keeps detection)', () => {
    const swap = classifyResource(
      res,
      live({ SecurityGroupIds: ['sg-0rogue0000000000a'] }),
      emptySchema,
      opts
    );
    expect(pathsByTier(swap, 'undeclared')).toEqual(['SecurityGroupIds']);
    const append = classifyResource(
      res,
      live({ SecurityGroupIds: ['sg-0722af66254639599', 'sg-0rogue0000000000a'] }),
      emptySchema,
      opts
    );
    expect(pathsByTier(append, 'undeclared')).toEqual(['SecurityGroupIds']);
  });
});

describe('VpcLattice ResourceConfiguration AllowAssociationToSharableServiceNetwork (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'Rc',
    resourceType: 'AWS::VpcLattice::ResourceConfiguration',
    physicalId: 'arn:aws:vpc-lattice:us-east-1:111111111111:resourceconfiguration/rcfg-x',
    declared: {
      Name: 'cdkrd-hunt-0715-rc',
      ResourceConfigurationType: 'SINGLE',
      ResourceGatewayId: 'rgw-062fc1eeaf119a6f6',
      PortRanges: ['80'],
      ProtocolType: 'TCP',
      ResourceConfigurationDefinition: { IpResource: { IpAddress: '10.0.0.10' } },
    },
  };

  it('folds the clean-deploy true to atDefault', () => {
    const f = classifyResource(
      res,
      { ...res.declared, AllowAssociationToSharableServiceNetwork: true },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('AllowAssociationToSharableServiceNetwork');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band false (the live-proven MEANINGFUL_WHEN_OFF flip)', () => {
    const f = classifyResource(
      res,
      { ...res.declared, AllowAssociationToSharableServiceNetwork: false },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['AllowAssociationToSharableServiceNetwork']);
  });
});

describe('VpcLattice ServiceNetwork lowercased CFn-generated Name (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'Sn',
    resourceType: 'AWS::VpcLattice::ServiceNetwork',
    physicalId: 'sn-035847d35c755a015',
    constructPath: 'CdkrdHunt0715Lattice/Sn',
    declared: { SharingConfig: { enabled: true } },
  };

  it('folds the lowercased <stack>-<logicalId>-<random> minted name as generated', () => {
    const f = classifyResource(
      res,
      { ...res.declared, Name: 'cdkrdhunt0715lattice-sn-f6xaf7zc2alb' },
      emptySchema
    );
    expect(pathsByTier(f, 'generated')).toEqual(['Name']);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('still surfaces a user-chosen lowercase name (value-dependent, not a blanket fold)', () => {
    const f = classifyResource(res, { ...res.declared, Name: 'my-network' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['Name']);
  });
});

describe('SES DedicatedIpPool ScalingMode first-run fold (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'SesPool',
    resourceType: 'AWS::SES::DedicatedIpPool',
    physicalId: 'cdkrd-hunt-0715-pool',
    declared: { PoolName: 'cdkrd-hunt-0715-pool' },
  };

  it('folds the undeclared STANDARD scaling mode to atDefault', () => {
    const f = classifyResource(res, { ...res.declared, ScalingMode: 'STANDARD' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toEqual(['ScalingMode']);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces a MANAGED pool (auto-leases billable IPs — not the default)', () => {
    const f = classifyResource(res, { ...res.declared, ScalingMode: 'MANAGED' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['ScalingMode']);
  });
});

describe('Backup RestoreTestingPlan first-run folds (2026-07-15 hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'RestorePlan',
    resourceType: 'AWS::Backup::RestoreTestingPlan',
    physicalId: 'cdkrd_hunt_0715_rtp',
    declared: {
      RestoreTestingPlanName: 'cdkrd_hunt_0715_rtp',
      ScheduleExpression: 'cron(0 5 ? * MON *)',
      RecoveryPointSelection: {
        Algorithm: 'LATEST_WITHIN_WINDOW',
        IncludeVaults: ['*'],
        RecoveryPointTypes: ['SNAPSHOT'],
      },
    },
  };
  const live = (over: Record<string, unknown> = {}) => ({
    ...res.declared,
    StartWindowHours: 24,
    ScheduleExpressionTimezone: 'Etc/UTC',
    RecoveryPointSelection: {
      ...(res.declared['RecoveryPointSelection'] as Record<string, unknown>),
      SelectionWindowDays: 30,
    },
    ...over,
  });

  it('folds the clean-deploy read (2 top-level + 1 nested default) — first run is CLEAN', () => {
    const f = classifyResource(res, live(), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toEqual([
      'RecoveryPointSelection.SelectionWindowDays',
      'ScheduleExpressionTimezone',
      'StartWindowHours',
    ]);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces each value changed off its default (the live-proven mutations)', () => {
    const f = classifyResource(
      res,
      live({ StartWindowHours: 12, ScheduleExpressionTimezone: 'America/New_York' }),
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'ScheduleExpressionTimezone',
      'StartWindowHours',
    ]);
    const nested = classifyResource(
      res,
      live({
        RecoveryPointSelection: {
          ...(res.declared['RecoveryPointSelection'] as Record<string, unknown>),
          SelectionWindowDays: 7,
        },
      }),
      emptySchema
    );
    expect(pathsByTier(nested, 'undeclared')).toEqual([
      'RecoveryPointSelection.SelectionWindowDays',
    ]);
  });
});

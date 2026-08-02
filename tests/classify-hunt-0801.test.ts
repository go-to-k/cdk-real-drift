// 2026-08-01 hunt (freepack) first-run FP fixes, live-proven on CdkrdHunt0801FreeA:
// - #1695 ASG MixedInstancesPolicy: the whole-object InstancesDistribution constant
//   echo + the referenced LT's minted-name echo inside LaunchTemplateSpecification.
// - #1696 TargetGroup cross-variants: GENEVE health checks default to TCP on the
//   FIXED port 80 (not traffic-port), and an HTTPS group's HC protocol default
//   FOLLOWS the group protocol.
// - #1697 EC2 Volume: a Size+AZ-only volume echoes the era default VolumeType gp2.
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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();
const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#1695 ASG MixedInstancesPolicy first-run echoes', () => {
  const declared = {
    MinSize: '0',
    MaxSize: '0',
    DesiredCapacity: '0',
    VPCZoneIdentifier: ['subnet-0123456789abcdef0'],
    MixedInstancesPolicy: {
      LaunchTemplate: {
        LaunchTemplateSpecification: {
          LaunchTemplateId: 'lt-0de70a90a79de7e5c',
          Version: '1',
        },
        Overrides: [{ InstanceType: 't3.micro' }],
      },
    },
  };
  const mk = (): DesiredResource => ({
    logicalId: 'MipAsg',
    resourceType: 'AWS::AutoScaling::AutoScalingGroup',
    physicalId: 'CdkrdHunt0801FreeA-MipAsg-abc',
    declared,
  });
  const liveMip = {
    InstancesDistribution: {
      OnDemandAllocationStrategy: 'prioritized',
      OnDemandBaseCapacity: 0,
      OnDemandPercentageAboveBaseCapacity: 100,
      SpotInstancePools: 2,
      SpotAllocationStrategy: 'lowest-price',
    },
    LaunchTemplate: {
      LaunchTemplateSpecification: {
        LaunchTemplateName: 'Lt_7FhOViharN3u',
        Version: '1',
        LaunchTemplateId: 'lt-0de70a90a79de7e5c',
      },
      Overrides: [{ InstanceType: 't3.micro' }],
    },
  };

  it('folds the InstancesDistribution constants + the minted LT-name echo (zero undeclared)', () => {
    const f = classifyResource(mk(), { ...declared, MixedInstancesPolicy: liveMip }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band spot-distribution change still surfaces (equality gate)', () => {
    const drifted = {
      ...liveMip,
      InstancesDistribution: {
        ...liveMip.InstancesDistribution,
        OnDemandPercentageAboveBaseCapacity: 50,
      },
    };
    const f = classifyResource(mk(), { ...declared, MixedInstancesPolicy: drifted }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['MixedInstancesPolicy.InstancesDistribution']);
  });
});

describe('#1696 TargetGroup GENEVE x instance / HTTPS health-check defaults', () => {
  const mkTg = (declared: Record<string, unknown>, logicalId: string): DesiredResource => ({
    logicalId,
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: `arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/${logicalId}/abc`,
    declared,
  });

  const geneveDeclared = {
    Protocol: 'GENEVE',
    Port: 6081,
    TargetType: 'instance',
    VpcId: 'vpc-0123456789abcdef0',
  };
  const geneveLive = {
    ...geneveDeclared,
    HealthCheckIntervalSeconds: 10,
    HealthCheckEnabled: true,
    HealthCheckTimeoutSeconds: 5,
    HealthyThresholdCount: 5,
    HealthCheckProtocol: 'TCP',
    HealthCheckPort: '80',
  };

  it('GENEVE x instance: the TCP/80 health-check echoes fold (zero undeclared)', () => {
    const f = classifyResource(mkTg(geneveDeclared, 'GeneveInstTg'), geneveLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('GENEVE: an out-of-band health-check port change still surfaces', () => {
    const f = classifyResource(
      mkTg(geneveDeclared, 'GeneveInstTg'),
      { ...geneveLive, HealthCheckPort: '8080' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['HealthCheckPort']);
  });

  const httpsDeclared = {
    Protocol: 'HTTPS',
    Port: 443,
    VpcId: 'vpc-0123456789abcdef0',
  };
  const httpsLive = {
    ...httpsDeclared,
    HealthCheckIntervalSeconds: 30,
    Matcher: { HttpCode: '200' },
    HealthCheckPath: '/',
    HealthCheckEnabled: true,
    HealthCheckTimeoutSeconds: 5,
    HealthyThresholdCount: 5,
    HealthCheckProtocol: 'HTTPS',
    TargetType: 'instance',
    HealthCheckPort: 'traffic-port',
  };

  it('HTTPS group: the HC-protocol-follows-protocol echo folds (zero undeclared)', () => {
    const f = classifyResource(mkTg(httpsDeclared, 'HttpsTg'), httpsLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('HTTPS group: an out-of-band HC-protocol downgrade to HTTP still surfaces', () => {
    const f = classifyResource(
      mkTg(httpsDeclared, 'HttpsTg'),
      { ...httpsLive, HealthCheckProtocol: 'HTTP' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['HealthCheckProtocol']);
  });
});

describe('#1698 mTLS listener AdvertiseTrustStoreCaNames attach echo', () => {
  const declared = {
    LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/x/abc',
    Protocol: 'HTTPS',
    Port: 443,
    Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/dummy' }],
    MutualAuthentication: {
      Mode: 'verify',
      TrustStoreArn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:truststore/ts/abc',
    },
    DefaultActions: [
      {
        Type: 'fixed-response',
        FixedResponseConfig: { StatusCode: '200', ContentType: 'text/plain' },
      },
    ],
  };
  const mk = (): DesiredResource => ({
    logicalId: 'MtlsListener',
    resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/x/abc/def',
    declared,
  });

  it('folds the undeclared AdvertiseTrustStoreCaNames off default on the attached shape', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        MutualAuthentication: {
          ...declared.MutualAuthentication,
          IgnoreClientCertificateExpiry: false,
          AdvertiseTrustStoreCaNames: 'off',
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band flip to on still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        MutualAuthentication: {
          ...declared.MutualAuthentication,
          AdvertiseTrustStoreCaNames: 'on',
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'MutualAuthentication.AdvertiseTrustStoreCaNames',
    ]);
  });
});

describe('#1699 barest Interface VPCEndpoint default-SG gate', () => {
  const declared = {
    VpcId: 'vpc-0123456789abcdef0',
    ServiceName: 'com.amazonaws.us-east-1.sqs',
    VpcEndpointType: 'Interface',
    SubnetIds: ['subnet-0123456789abcdef0'],
  };
  const mk = (): DesiredResource => ({
    logicalId: 'SqsIfEp',
    resourceType: 'AWS::EC2::VPCEndpoint',
    physicalId: 'vpce-0123456789abcdef0',
    declared,
  });

  it('folds the single VPC-default SG to atDefault', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SecurityGroupIds: ['sg-0d2cd899a027df8ca'] },
      emptySchema,
      { defaultSgIds: new Set(['sg-0d2cd899a027df8ca']) }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band SG append still surfaces (single-default gate)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SecurityGroupIds: ['sg-0d2cd899a027df8ca', 'sg-0rogue'] },
      emptySchema,
      { defaultSgIds: new Set(['sg-0d2cd899a027df8ca']) }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['SecurityGroupIds']);
  });
});

describe('#1700 GuardDuty Detector partial-declared DataSources off-flip', () => {
  const declared = {
    Enable: true,
    DataSources: { S3Logs: { Enable: true } },
  };
  const mk = (): DesiredResource => ({
    logicalId: 'Detector',
    resourceType: 'AWS::GuardDuty::Detector',
    physicalId: 'b3c66db5f2a2481997d50aa4460d2141',
    declared,
  });
  const liveClean = {
    ...declared,
    DataSources: {
      S3Logs: { Enable: true },
      Kubernetes: { AuditLogs: { Enable: true } },
      MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: true } },
    },
  };

  it('clean partial-declared deploy: the all-true siblings fold (zero undeclared)', () => {
    const f = classifyResource(mk(), liveClean, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band all-false disable of a sibling protection surfaces (off-state gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        DataSources: {
          S3Logs: { Enable: true },
          Kubernetes: { AuditLogs: { Enable: false } },
          MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: true } },
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['DataSources.Kubernetes']);
  });
});

describe('#1701 Cognito UserPool partial-declared PasswordPolicy (determination)', () => {
  // A partially-declared PasswordPolicy is filled with Require*=FALSE by the service
  // (corpus proof: Users0A0EEA89) — an undeclared false leaf is the CREATION state, so it
  // must stay invisible; only the MinimumLength 8 fill is a foldable constant default.
  const noLenDeclared = {
    UserPoolName: 'hunt-pool',
    Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: 7 } },
  };
  const mk = (): DesiredResource => ({
    logicalId: 'Pool',
    resourceType: 'AWS::Cognito::UserPool',
    physicalId: 'us-east-1_dj8cDsvBc',
    declared: noLenDeclared,
  });
  const filledPolicy = {
    MinimumLength: 8,
    RequireLowercase: false,
    RequireNumbers: false,
    RequireSymbols: false,
    RequireUppercase: false,
    TemporaryPasswordValidityDays: 7,
  };

  it('the service-filled partial shape (MinimumLength 8 + false Require* fills) is clean', () => {
    const f = classifyResource(
      mk(),
      { ...noLenDeclared, Policies: { PasswordPolicy: filledPolicy } },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band MinimumLength weakening to 6 surfaces (equality gate on the 8 pin)', () => {
    const f = classifyResource(
      mk(),
      { ...noLenDeclared, Policies: { PasswordPolicy: { ...filledPolicy, MinimumLength: 6 } } },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['Policies.PasswordPolicy.MinimumLength']);
  });
});

describe('#1703 Route53 HealthCheck type-derived Port default', () => {
  const mkHc = (config: Record<string, unknown>): DesiredResource => ({
    logicalId: 'HttpHc',
    resourceType: 'AWS::Route53::HealthCheck',
    physicalId: 'hc-0123',
    declared: { HealthCheckConfig: config },
  });

  it('a barest HTTP check folds the undeclared Port 80 echo', () => {
    const cfg = { Type: 'HTTP', FullyQualifiedDomainName: 'example.com' };
    const f = classifyResource(mkHc(cfg), { HealthCheckConfig: { ...cfg, Port: 80 } }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an HTTPS check folds 443, and an out-of-band port change surfaces', () => {
    const cfg = { Type: 'HTTPS', FullyQualifiedDomainName: 'example.com' };
    const clean = classifyResource(
      mkHc(cfg),
      { HealthCheckConfig: { ...cfg, Port: 443 } },
      emptySchema
    );
    expect(pathsByTier(clean, 'undeclared')).toEqual([]);
    const drifted = classifyResource(
      mkHc(cfg),
      { HealthCheckConfig: { ...cfg, Port: 8443 } },
      emptySchema
    );
    expect(pathsByTier(drifted, 'undeclared')).toEqual(['HealthCheckConfig.Port']);
  });
});

describe('#1704 RDS read-replica inherited echoes', () => {
  const declared = {
    SourceDBInstanceIdentifier: 'src-db-0801',
    DBInstanceClass: 'db.t4g.micro',
  };
  // The REAL schema marks SourceDBInstanceIdentifier writeOnly — the overlay must key on
  // the PRE-strip snapshot (the #1500 trap; an emptySchema here would hide a regression
  // where the derivation reads the stripped `declared` and silently no-ops, exactly what
  // the first statepack live run caught).
  const replicaSchema: SchemaInfo = {
    ...emptySchema,
    writeOnly: new Set(['SourceDBInstanceIdentifier']),
    writeOnlyPaths: ['SourceDBInstanceIdentifier'],
  };
  const mk = (): DesiredResource => ({
    logicalId: 'ReplicaDb',
    resourceType: 'AWS::RDS::DBInstance',
    physicalId: 'replica-db-0801',
    // fresh object per call — classify strips writeOnly paths from `declared` in place
    declared: { ...declared },
  });
  const liveInherited = {
    DBInstanceClass: 'db.t4g.micro',
    Engine: 'postgres',
    AllocatedStorage: '400',
    MasterUsername: 'cdkrdhunt',
    BackupRetentionPeriod: 0,
    // The group names joined the inherit list 2026-08-02 (live-caught on the
    // rds-replica-hunt first check): an undeclared replica reads back the SOURCE's
    // parameter + subnet groups.
    DBParameterGroupName: 'cdkrdhunt-mixed-dpg',
    DBSubnetGroupName: 'cdkrdhunt-mixed-sng',
  };
  const srcModels = {
    'src-db-0801': {
      DBInstanceIdentifier: 'src-db-0801',
      Engine: 'postgres',
      AllocatedStorage: '400',
      MasterUsername: 'cdkrdhunt',
      DBParameterGroupName: 'cdkrdhunt-mixed-dpg',
      DBSubnetGroupName: 'cdkrdhunt-mixed-sng',
    },
  };

  it('folds the source-inherited echoes + the replica BackupRetentionPeriod 0 (zero undeclared)', () => {
    const f = classifyResource(mk(), liveInherited, replicaSchema, {
      siblingRdsSourceModels: srcModels,
    });
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a replica value diverging from the source still surfaces (equality gate)', () => {
    const f = classifyResource(mk(), { ...liveInherited, AllocatedStorage: '500' }, replicaSchema, {
      siblingRdsSourceModels: srcModels,
    });
    expect(pathsByTier(f, 'undeclared')).toEqual(['AllocatedStorage']);
  });

  it('a replica re-pointed at a different parameter group still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      { ...liveInherited, DBParameterGroupName: 'some-other-group' },
      replicaSchema,
      { siblingRdsSourceModels: srcModels }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['DBParameterGroupName']);
  });

  it('an out-of-stack source (no sibling model) leaves the inherited values unfolded — fail-safe', () => {
    const f = classifyResource(mk(), liveInherited, replicaSchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'AllocatedStorage',
      'DBParameterGroupName',
      'DBSubnetGroupName',
      'Engine',
      'MasterUsername',
    ]);
  });
});

describe('#1705 Cassandra Table TTL constant + provisioned WarmThroughput derivation', () => {
  const mkTable = (declared: Record<string, unknown>, logicalId: string): DesiredResource => ({
    logicalId,
    resourceType: 'AWS::Cassandra::Table',
    physicalId: 'cdkrd_hunt0801|barest0801',
    declared,
  });

  it('a barest table folds the DefaultTimeToLive 0 echo', () => {
    const declared = {
      KeyspaceName: 'cdkrd_hunt0801',
      TableName: 'barest0801',
      PartitionKeyColumns: [{ ColumnName: 'pk', ColumnType: 'text' }],
    };
    const f = classifyResource(
      mkTable(declared, 'BarestTable'),
      { ...declared, DefaultTimeToLive: 0 },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a PROVISIONED table folds WarmThroughput echoing its own declared capacity', () => {
    const declared = {
      KeyspaceName: 'cdkrd_hunt0801',
      TableName: 'prov0801',
      PartitionKeyColumns: [{ ColumnName: 'pk', ColumnType: 'text' }],
      BillingMode: {
        Mode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      },
    };
    const clean = classifyResource(
      mkTable(declared, 'ProvTable'),
      {
        ...declared,
        WarmThroughput: { ReadUnitsPerSecond: 1, WriteUnitsPerSecond: 1 },
        DefaultTimeToLive: 0,
      },
      emptySchema
    );
    expect(pathsByTier(clean, 'undeclared')).toEqual([]);
    const drifted = classifyResource(
      mkTable(declared, 'ProvTable'),
      { ...declared, WarmThroughput: { ReadUnitsPerSecond: 9000, WriteUnitsPerSecond: 9000 } },
      emptySchema
    );
    expect(pathsByTier(drifted, 'undeclared')).toEqual(['WarmThroughput']);
  });
});

describe('#1706 memcached CacheCluster undeclared EngineVersion (moving GA version)', () => {
  const declared = {
    Engine: 'memcached',
    CacheNodeType: 'cache.t3.micro',
    NumCacheNodes: 2,
    CacheSubnetGroupName: 'cdkrd-subnets',
    VpcSecurityGroupIds: ['sg-0123456789abcdef0'],
  };
  const mk = (): DesiredResource => ({
    logicalId: 'Memcached0801',
    resourceType: 'AWS::ElastiCache::CacheCluster',
    physicalId: 'cdkrdhunt0801-memcached',
    declared,
  });

  it('folds the undeclared GA track echo value-independently (zero undeclared)', () => {
    const f = classifyResource(mk(), { ...declared, EngineVersion: '1.6' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

describe('#1697 EC2 Volume VolumeType gp2 era default', () => {
  const declared = { AvailabilityZone: 'us-east-1a', Size: 10 };
  const mk = (): DesiredResource => ({
    logicalId: 'BarestVol',
    resourceType: 'AWS::EC2::Volume',
    physicalId: 'vol-0eeb30b7ba7374872',
    declared,
  });

  it('a Size+AZ-only volume folds the gp2 echo (zero undeclared)', () => {
    const f = classifyResource(mk(), { ...declared, VolumeType: 'gp2' }, emptySchema);
    expect(tierPaths(f)).toEqual(['atDefault:VolumeType']);
  });

  it('an out-of-band type migration still surfaces', () => {
    const f = classifyResource(mk(), { ...declared, VolumeType: 'gp3' }, emptySchema);
    expect(tierPaths(f)).toEqual(['undeclared:VolumeType']);
  });
});

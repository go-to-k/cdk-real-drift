// #958 RedshiftServerless Namespace/Workgroup first-run FP batch + #977 MSK::Cluster
// first-run FP trio. Each fold is asserted BOTH ways: the undeclared AWS creation default
// folds (atDefault / generated) so a clean first check is zero-drift, and — for the
// equality-gated (tier-1) ones — a value CHANGED away from the default still surfaces
// (out-of-band detection preserved). The value-independent (tier-3) folds preserve no
// detection by design (the value is undeclared per-account/AWS-assigned), so they are
// asserted only in the fold direction.
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
): DesiredResource => ({ logicalId: 'R', resourceType, physicalId, declared });

describe('#958 RedshiftServerless Namespace DbName default', () => {
  const ns = mk('AWS::RedshiftServerless::Namespace', { NamespaceName: 'ns' });
  it('folds the undeclared DbName "dev" to atDefault (tier 1)', () => {
    const f = classifyResource(ns, { DbName: 'dev' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('DbName');
    expect(tier(f, 'undeclared')).not.toContain('DbName');
  });
  it('surfaces a namespace that pins a non-default DbName (detection preserved)', () => {
    const f = classifyResource(ns, { DbName: 'analytics' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('DbName');
  });
});

describe('#958 RedshiftServerless Workgroup placement + config parameters', () => {
  const wg = mk('AWS::RedshiftServerless::Workgroup', { WorkgroupName: 'wg' });
  it('folds undeclared default-VPC SecurityGroupIds/SubnetIds value-independent (tier 3)', () => {
    const f = classifyResource(
      wg,
      {
        SecurityGroupIds: ['sg-0a26e23e2310ee0c9'],
        SubnetIds: ['subnet-00c21350a74a112b8', 'subnet-11c21350a74a112b8'],
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(expect.arrayContaining(['SecurityGroupIds', 'SubnetIds']));
    expect(tier(f, 'undeclared')).not.toContain('SecurityGroupIds');
    expect(tier(f, 'undeclared')).not.toContain('SubnetIds');
  });
  it('folds each undeclared default ConfigParameter PER-ELEMENT (tier 2, #1272 superseded the tier-3 fold)', () => {
    const f = classifyResource(
      wg,
      {
        ConfigParameters: [
          { ParameterKey: 'auto_mv', ParameterValue: 'true' },
          { ParameterKey: 'datestyle', ParameterValue: 'ISO, MDY' },
          { ParameterKey: 'enable_case_sensitive_identifier', ParameterValue: 'false' },
        ],
      },
      emptySchema
    );
    // #1272: ConfigParameters is no longer folded whole (value-independent); each element folds
    // atDefault by ParameterKey against the harvested defaults, so an OOB change to a known key
    // (require_ssl=false) surfaces while the defaults stay folded.
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining([
        'ConfigParameters[auto_mv]',
        'ConfigParameters[datestyle]',
        'ConfigParameters[enable_case_sensitive_identifier]',
      ])
    );
    expect(tier(f, 'undeclared')).toHaveLength(0);
  });
});

describe('#977 MSK::Cluster first-run FP trio', () => {
  const declaredBroker = {
    ClientSubnets: ['subnet-a', 'subnet-b'],
    InstanceType: 'kafka.t3.small',
    StorageInfo: { EBSStorageInfo: { VolumeSize: 10 } },
  };
  const mkMsk = (broker: Record<string, unknown>) =>
    mk('AWS::MSK::Cluster', {
      ClusterName: 'c',
      KafkaVersion: '3.6.0',
      NumberOfBrokerNodes: 2,
      BrokerNodeGroupInfo: broker,
    });
  const cleanLive = {
    BrokerNodeGroupInfo: {
      ...declaredBroker,
      SecurityGroups: ['sg-059dd37aa34acef10'],
      ConnectivityInfo: {
        NetworkType: 'IPV4',
        VpcConnectivity: {
          ClientAuthentication: {
            Sasl: { Iam: { Enabled: false }, Scram: { Enabled: false } },
            Tls: { Enabled: false },
          },
        },
        PublicAccess: { Type: 'DISABLED' },
      },
    },
    EncryptionInfo: {
      EncryptionAtRest: {
        DataVolumeKMSKeyId: 'arn:aws:kms:us-east-1:111111111111:key/uuid',
      },
      EncryptionInTransit: { ClientBroker: 'TLS', InCluster: true },
    },
  };

  it('a clean minimal cluster produces ZERO undeclared/declared drift', () => {
    const f = classifyResource(mkMsk(declaredBroker), structuredClone(cleanLive), emptySchema);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('folds EncryptionInfo.EncryptionInTransit constant to atDefault (tier 1)', () => {
    const f = classifyResource(mkMsk(declaredBroker), structuredClone(cleanLive), emptySchema);
    expect(tier(f, 'atDefault')).toContain('EncryptionInfo.EncryptionInTransit');
  });

  it('folds EncryptionInfo.EncryptionAtRest per-account KMS value-independent (tier 3)', () => {
    const f = classifyResource(mkMsk(declaredBroker), structuredClone(cleanLive), emptySchema);
    expect(tier(f, 'generated')).toContain('EncryptionInfo.EncryptionAtRest');
  });

  it('folds BrokerNodeGroupInfo.ConnectivityInfo constant to atDefault (tier 1)', () => {
    const f = classifyResource(mkMsk(declaredBroker), structuredClone(cleanLive), emptySchema);
    expect(tier(f, 'atDefault')).toContain('BrokerNodeGroupInfo.ConnectivityInfo');
  });

  it('folds default-VPC BrokerNodeGroupInfo.SecurityGroups value-independent (tier 3)', () => {
    const f = classifyResource(mkMsk(declaredBroker), structuredClone(cleanLive), emptySchema);
    expect(tier(f, 'generated')).toContain('BrokerNodeGroupInfo.SecurityGroups');
  });

  it('surfaces an out-of-band in-transit downgrade (ClientBroker -> PLAINTEXT)', () => {
    const live = structuredClone(cleanLive);
    live.EncryptionInfo.EncryptionInTransit.ClientBroker = 'PLAINTEXT';
    const f = classifyResource(mkMsk(declaredBroker), live, emptySchema);
    expect(tier(f, 'undeclared')).toContain('EncryptionInfo.EncryptionInTransit');
    expect(tier(f, 'atDefault')).not.toContain('EncryptionInfo.EncryptionInTransit');
  });

  it('surfaces an out-of-band public-access enable (PublicAccess.Type)', () => {
    const live = structuredClone(cleanLive);
    live.BrokerNodeGroupInfo.ConnectivityInfo.PublicAccess.Type = 'SERVICE_PROVIDED_EIPS';
    const f = classifyResource(mkMsk(declaredBroker), live, emptySchema);
    expect(tier(f, 'undeclared')).toContain('BrokerNodeGroupInfo.ConnectivityInfo');
    expect(tier(f, 'atDefault')).not.toContain('BrokerNodeGroupInfo.ConnectivityInfo');
  });

  it('surfaces an out-of-band VPC-connectivity Sasl/Iam enable', () => {
    const live = structuredClone(cleanLive);
    live.BrokerNodeGroupInfo.ConnectivityInfo.VpcConnectivity.ClientAuthentication.Sasl.Iam.Enabled = true;
    const f = classifyResource(mkMsk(declaredBroker), live, emptySchema);
    expect(tier(f, 'undeclared')).toContain('BrokerNodeGroupInfo.ConnectivityInfo');
  });
});

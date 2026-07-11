// #640 — EC2 Instance / Volume / NetworkInterface first-run undeclared batch (the
// pure-noise.ts subset: equality-gated constants + value-independent AWS-assigned
// identifiers). Every test asserts the fold AND, where the fold is equality-gated,
// that a genuine divergence still surfaces. The derived/sibling members of #640
// (Instance CpuOptions/sibling echoes, Volume gp2 Iops, ENI SecondaryPrivateIpAddressCount)
// need classify.ts logic and are tracked separately on the issue.
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

const IMDS_DEFAULT = {
  HttpTokens: 'required',
  HttpPutResponseHopLimit: 2,
  HttpProtocolIpv6: 'disabled',
  InstanceMetadataTags: 'disabled',
  HttpEndpoint: 'enabled',
};
const DNS_DEFAULT = {
  HostnameType: 'ip-name',
  EnableResourceNameDnsARecord: false,
  EnableResourceNameDnsAAAARecord: false,
};

describe('#640 EC2 Instance MetadataOptions / PrivateDnsNameOptions (equality-gated constants)', () => {
  const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' });
  it('folds the AL2023 IMDSv2 + ip-name DNS defaults on a clean deploy', () => {
    const f = classifyResource(
      res,
      { MetadataOptions: IMDS_DEFAULT, PrivateDnsNameOptions: DNS_DEFAULT },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['MetadataOptions', 'PrivateDnsNameOptions'])
    );
    expect(tier(f, 'undeclared')).not.toContain('MetadataOptions');
    expect(tier(f, 'undeclared')).not.toContain('PrivateDnsNameOptions');
  });
  it('surfaces an out-of-band IMDSv2 weakening (HttpTokens optional) — detection preserved', () => {
    const f = classifyResource(
      res,
      { MetadataOptions: { ...IMDS_DEFAULT, HttpTokens: 'optional' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('MetadataOptions');
  });
  it('surfaces an out-of-band resource-name hostname switch — detection preserved', () => {
    const f = classifyResource(
      res,
      { PrivateDnsNameOptions: { ...DNS_DEFAULT, HostnameType: 'resource-name' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('PrivateDnsNameOptions');
  });
});

describe('#640 EC2 Volume KmsKeyId / AvailabilityZoneId (value-independent, undeclared)', () => {
  const res = mk('AWS::EC2::Volume', {
    AvailabilityZone: 'us-east-1a',
    Encrypted: true,
    Size: 8,
    VolumeType: 'gp3',
  });
  it('folds the AWS-assigned aws/ebs managed key ARN and the derived zone id', () => {
    const f = classifyResource(
      res,
      {
        KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc-123',
        AvailabilityZoneId: 'use1-az1',
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['KmsKeyId', 'AvailabilityZoneId'])
    );
    // value-independent: any key ARN folds (the volume key is create-only, cannot drift).
    const f2 = classifyResource(
      res,
      { KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/some-cmk' },
      emptySchema
    );
    expect(tier(f2, 'atDefault')).toContain('KmsKeyId');
  });
});

describe('#640 EC2 NetworkInterface PrivateIpAddresses / GroupSet (value-independent, undeclared)', () => {
  const res = mk('AWS::EC2::NetworkInterface', { SubnetId: 'subnet-1', Description: 'd' });
  it('folds the auto-assigned primary IP array and the VPC default security group', () => {
    const f = classifyResource(
      res,
      {
        PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.7', Primary: true }],
        GroupSet: ['sg-0abc'],
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['PrivateIpAddresses', 'GroupSet'])
    );
  });
  it('does NOT fold when the user declares them (compared in the declared loop instead)', () => {
    const declaredRes = mk('AWS::EC2::NetworkInterface', {
      SubnetId: 'subnet-1',
      GroupSet: ['sg-declared'],
    });
    const f = classifyResource(declaredRes, { GroupSet: ['sg-different'] }, emptySchema);
    // a declared GroupSet that differs from live surfaces as declared drift, not atDefault.
    expect(tier(f, 'atDefault')).not.toContain('GroupSet');
  });
});

describe('#640 EC2 Instance AvailabilityZone (create-only, value-independent, undeclared)', () => {
  // Live-repro (2026-07-11): a CfnInstance placed by SubnetId, declaring no AZ, reads back
  // AvailabilityZone = "us-east-1a" — the create-only twin of the folded SubnetId/CpuOptions.
  const res = mk('AWS::EC2::Instance', {
    ImageId: 'ami-1',
    InstanceType: 't3.micro',
    SubnetId: 'subnet-1',
  });
  it('folds the AWS-assigned AZ on a clean deploy (undeclared -> atDefault)', () => {
    const f = classifyResource(res, { AvailabilityZone: 'us-east-1a' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('AvailabilityZone');
    expect(tier(f, 'undeclared')).not.toContain('AvailabilityZone');
  });
  it('is value-independent: any AZ folds (create-only, physically cannot drift out of band)', () => {
    for (const az of ['us-east-1a', 'us-east-1b', 'eu-west-1c']) {
      const f = classifyResource(res, { AvailabilityZone: az }, emptySchema);
      expect(tier(f, 'atDefault')).toContain('AvailabilityZone');
    }
  });
  it('does NOT fold a DECLARED AvailabilityZone that differs — declared drift still surfaces', () => {
    const declaredRes = mk('AWS::EC2::Instance', {
      ImageId: 'ami-1',
      InstanceType: 't3.micro',
      AvailabilityZone: 'us-east-1a',
    });
    const f = classifyResource(declaredRes, { AvailabilityZone: 'us-east-1b' }, emptySchema);
    expect(tier(f, 'atDefault')).not.toContain('AvailabilityZone');
    expect(tier(f, 'declared')).toContain('AvailabilityZone');
  });
});

describe('#640 EC2 Instance SecurityGroups / Volumes / BlockDeviceMappings / NetworkInterfaces (reach ZERO)', () => {
  // A fresh CfnInstance declaring only ImageId/InstanceType/SubnetId/SecurityGroupIds reads back all
  // four of these undeclared on a clean deploy (live-confirmed 2026-07-11). Each folds atDefault —
  // detection is preserved via the mechanism noted per path.
  const res = mk('AWS::EC2::Instance', {
    ImageId: 'ami-1',
    InstanceType: 't3.micro',
    SubnetId: 'subnet-1',
    SecurityGroupIds: ['sg-1'],
  });
  const LIVE = {
    SecurityGroups: ['StackName-BenchSecurityGroup-abc123'],
    Volumes: [{ VolumeId: 'vol-0abc', Device: '/dev/xvda' }],
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/xvda',
        Ebs: {
          SnapshotId: 'snap-1',
          VolumeType: 'gp3',
          Encrypted: false,
          Iops: 3000,
          VolumeSize: 8,
        },
      },
    ],
    NetworkInterfaces: [{ DeviceIndex: '0', SubnetId: 'subnet-1', GroupSet: ['sg-1'] }],
  };
  it('folds all four undeclared AWS-auto-created baselines on a clean deploy (ZERO potential drift)', () => {
    const f = classifyResource(res, LIVE, emptySchema);
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining([
        'SecurityGroups',
        'Volumes',
        'BlockDeviceMappings',
        'NetworkInterfaces',
      ])
    );
    expect(tier(f, 'undeclared')).toEqual([]);
  });
  it('SecurityGroups is value-independent (any name folds — the SecurityGroupIds sibling detects swaps)', () => {
    const f = classifyResource(res, { SecurityGroups: ['some-other-sg-name'] }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('SecurityGroups');
  });
  it('NetworkInterfaces SURFACES an out-of-band ENI attach (a non-primary DeviceIndex)', () => {
    const f = classifyResource(
      res,
      {
        NetworkInterfaces: [
          { DeviceIndex: '0', SubnetId: 'subnet-1' },
          { DeviceIndex: '1', SubnetId: 'subnet-1' }, // rogue attached ENI
        ],
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('NetworkInterfaces');
    expect(tier(f, 'atDefault')).not.toContain('NetworkInterfaces');
  });
  it('NetworkInterfaces folds the lone auto-created primary (DeviceIndex 0)', () => {
    const f = classifyResource(
      res,
      { NetworkInterfaces: [{ DeviceIndex: '0', SubnetId: 'subnet-1' }] },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('NetworkInterfaces');
  });
  it('does NOT fold declared NetworkInterfaces — compared in the declared loop instead', () => {
    const declaredRes = mk('AWS::EC2::Instance', {
      ImageId: 'ami-1',
      InstanceType: 't3.micro',
      NetworkInterfaces: [{ DeviceIndex: '0', SubnetId: 'subnet-declared' }],
    });
    const f = classifyResource(
      declaredRes,
      { NetworkInterfaces: [{ DeviceIndex: '0', SubnetId: 'subnet-different' }] },
      emptySchema
    );
    expect(tier(f, 'atDefault')).not.toContain('NetworkInterfaces');
  });
});

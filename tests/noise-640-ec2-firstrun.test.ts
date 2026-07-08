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

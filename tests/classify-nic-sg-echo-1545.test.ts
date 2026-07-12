// #1545 — an EC2 Instance that declares its security groups via inline
// NetworkInterfaces[0].GroupSet (the CDK L2 shape whenever a NIC-level prop like
// AssociatePublicIpAddress is set) reads back the SAME list echoed as undeclared
// top-level SecurityGroupIds. The #640 gate only folds the VPC-default-SG case, so
// the custom-SG echo FP'd on every first check (live-proven, CdkrdHunt0713bImds,
// us-east-1, 2026-07-13). Now a tier-2 derived fold: order-insensitive equality
// against the resolved DeviceIndex-0 GroupSet; an out-of-band swap/append still
// surfaces (falls through to the default-SG gate).
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

const declared = {
  ImageId: 'ami-0123456789abcdef0',
  InstanceType: 't4g.nano',
  NetworkInterfaces: [
    {
      DeviceIndex: '0',
      AssociatePublicIpAddress: false,
      GroupSet: ['sg-007361890adb9da9d'],
      SubnetId: 'subnet-0123456789abcdef0',
    },
  ],
};

const mk = (): DesiredResource => ({
  logicalId: 'HuntInstance',
  resourceType: 'AWS::EC2::Instance',
  physicalId: 'i-0a7d7a1211d3bee78',
  declared,
});

describe('#1545 NIC-inline GroupSet echo as top-level SecurityGroupIds', () => {
  it('folds the echo of the declared DeviceIndex-0 GroupSet to atDefault', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SecurityGroupIds: ['sg-007361890adb9da9d'] },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('SecurityGroupIds');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  // The fall-through default-SG gate fails OPEN without the prefetch, so the surface
  // assertions pass opts.defaultSgIds (the resolved VPC-default set) like gather does.
  const defaultSgIds = new Set(['sg-0defau1tdefau1t0']);

  it('an out-of-band SG swap no longer matches and surfaces', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SecurityGroupIds: ['sg-0badbadbadbadbad0'] },
      emptySchema,
      { defaultSgIds }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['SecurityGroupIds']);
  });

  it('an out-of-band SG APPEND no longer matches and surfaces', () => {
    const f = classifyResource(
      mk(),
      { ...declared, SecurityGroupIds: ['sg-007361890adb9da9d', 'sg-0badbadbadbadbad0'] },
      emptySchema,
      { defaultSgIds }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['SecurityGroupIds']);
  });
});

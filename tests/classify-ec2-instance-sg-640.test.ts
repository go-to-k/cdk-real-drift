// #640: an EC2 Instance that declares no security group reads back its VPC's single default SG id
// in `SecurityGroupIds`. It was surfacing as first-run undeclared drift on every clean instance.
// It is OOB-mutable (`ec2 modify-instance-attribute --groups`), so — like the ALB/ENI/Neptune/MQ/
// Workgroup cases (#889/#976/#1266/#1269) — it must fold through the derived VPC-default-SG GATE,
// not value-independent: fold a single default SG (clean deploy), surface an append or a swap to a
// non-default SG (a rogue out-of-band change), fail open when the prefetch is unavailable.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, shouldFoldDefaultSgList } from '../src/diff/classify.js';
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
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Inst',
  resourceType: 'AWS::EC2::Instance',
  physicalId: 'i-000000000000',
  declared,
});

const DEFAULT_SG = 'sg-0defau1t00000000';
const ROGUE_SG = 'sg-0rogue00000000000';
const defaultSgIds = new Set([DEFAULT_SG]);
const key = 'SecurityGroupIds';

describe('#640 EC2::Instance.SecurityGroupIds derived VPC-default-SG gate', () => {
  // A CDK instance declares InstanceType/ImageId/SubnetId but no SG; AWS assigns the VPC default SG.
  const res = mk({ ImageId: 'ami-0', InstanceType: 't3.micro', SubnetId: 'subnet-0' });

  it('folds a single VPC-default SG (clean deploy)', () => {
    expect(
      tier(
        classifyResource(res, { [key]: [DEFAULT_SG] }, emptySchema, { defaultSgIds }),
        'atDefault'
      )
    ).toContain(key);
  });

  it('surfaces an out-of-band SG append (2+ elements)', () => {
    expect(
      tier(
        classifyResource(res, { [key]: [DEFAULT_SG, ROGUE_SG] }, emptySchema, { defaultSgIds }),
        'undeclared'
      )
    ).toContain(key);
  });

  it('surfaces an out-of-band SG swap (single non-default SG)', () => {
    expect(
      tier(
        classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, { defaultSgIds }),
        'undeclared'
      )
    ).toContain(key);
  });

  it('fails open when the default-SG prefetch is unavailable (no first-run FP)', () => {
    expect(
      tier(classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, {}), 'atDefault')
    ).toContain(key);
  });

  it('pure decision covers the EC2::Instance SG path', () => {
    const t = 'AWS::EC2::Instance';
    expect(shouldFoldDefaultSgList(t, key, [DEFAULT_SG], defaultSgIds)).toBe(true);
    expect(shouldFoldDefaultSgList(t, key, [ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(t, key, [DEFAULT_SG, ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(t, key, [ROGUE_SG], undefined)).toBe(true); // fail open
  });
});

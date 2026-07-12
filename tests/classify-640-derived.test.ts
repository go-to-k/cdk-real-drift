// #640 — the DERIVED remainder (classify.ts tier-2 folds computed from declared inputs):
//   - Instance CreditSpecification.CPUCredits from the InstanceType burstable FAMILY,
//   - Volume gp2 Iops = clamp(3 * Size, 100, 16000),
//   - NetworkInterface SecondaryPrivateIpAddressCount = max(0, len(PrivateIpAddresses) - 1).
// Each test asserts the clean-deploy fold to atDefault AND that a value away from the
// computed default still surfaces as undeclared (detection preserved).
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

describe('#640 EC2 Instance CreditSpecification derived from InstanceType family', () => {
  it('folds "unlimited" on a t3 burstable instance (t3/t3a/t4g default)', () => {
    const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' });
    const f = classifyResource(
      res,
      { CreditSpecification: { CPUCredits: 'unlimited' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
    expect(tier(f, 'undeclared')).not.toContain('CreditSpecification');
  });
  it('folds "standard" on a t2 burstable instance (t2 default)', () => {
    const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't2.small' });
    const f = classifyResource(
      res,
      { CreditSpecification: { CPUCredits: 'standard' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
    expect(tier(f, 'undeclared')).not.toContain('CreditSpecification');
  });
  it('surfaces a t3 instance pinned to "standard" (away from the t3 default) — detection preserved', () => {
    const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' });
    const f = classifyResource(
      res,
      { CreditSpecification: { CPUCredits: 'standard' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('CreditSpecification');
  });
  it('folds "standard" on a non-burstable (m5) instance — the meaningless echo AWS returns', () => {
    // #640 (2026-07-12): a fresh non-burstable m5.large echoes an undeclared
    // CreditSpecification={CPUCredits:"standard"} on first check — fold it (non-T families default
    // "standard"), else a clean deploy shows a first-run false positive.
    const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 'm5.large' });
    const f = classifyResource(
      res,
      { CreditSpecification: { CPUCredits: 'standard' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
    expect(tier(f, 'undeclared')).not.toContain('CreditSpecification');
  });
  it('surfaces a non-burstable (m5) instance reading a non-"standard" value — detection preserved', () => {
    const res = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 'm5.large' });
    const f = classifyResource(
      res,
      { CreditSpecification: { CPUCredits: 'unlimited' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('CreditSpecification');
  });
});

describe('#640 EC2 Volume gp2 Iops derived from Size', () => {
  it('folds the clamped-floor 100 IOPS for a small gp2 volume (Size 20 -> max(100, 60))', () => {
    const res = mk('AWS::EC2::Volume', { VolumeType: 'gp2', Size: 20, Encrypted: true });
    const f = classifyResource(res, { Iops: 100 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Iops');
    expect(tier(f, 'undeclared')).not.toContain('Iops');
  });
  it('folds the 3-IOPS/GiB baseline for a larger gp2 volume (Size 1000 -> 3000)', () => {
    const res = mk('AWS::EC2::Volume', { VolumeType: 'gp2', Size: 1000 });
    const f = classifyResource(res, { Iops: 3000 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Iops');
  });
  it('folds gp2 as the default VolumeType when omitted', () => {
    const res = mk('AWS::EC2::Volume', { Size: 20 });
    const f = classifyResource(res, { Iops: 100 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Iops');
  });
  it('surfaces a gp2 volume with a bumped Iops (away from the baseline) — detection preserved', () => {
    const res = mk('AWS::EC2::Volume', { VolumeType: 'gp2', Size: 20 });
    const f = classifyResource(res, { Iops: 500 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('Iops');
  });
});

describe('#640 EC2 NetworkInterface SecondaryPrivateIpAddressCount derived from PrivateIpAddresses', () => {
  it('folds the all-but-primary count for a declared IP list (4 IPs -> 3)', () => {
    const res = mk('AWS::EC2::NetworkInterface', {
      SubnetId: 'subnet-1',
      PrivateIpAddresses: [
        { Primary: true, PrivateIpAddress: '10.0.0.10' },
        { Primary: false, PrivateIpAddress: '10.0.0.200' },
        { Primary: false, PrivateIpAddress: '10.0.0.50' },
        { Primary: false, PrivateIpAddress: '10.0.0.150' },
      ],
    });
    const f = classifyResource(res, { SecondaryPrivateIpAddressCount: 3 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('SecondaryPrivateIpAddressCount');
    expect(tier(f, 'undeclared')).not.toContain('SecondaryPrivateIpAddressCount');
  });
  it('folds 0 for a single-primary-only declared list', () => {
    const res = mk('AWS::EC2::NetworkInterface', {
      SubnetId: 'subnet-1',
      PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: '10.0.0.10' }],
    });
    const f = classifyResource(res, { SecondaryPrivateIpAddressCount: 0 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('SecondaryPrivateIpAddressCount');
  });
  it('surfaces a count that does not match the declared IP list — detection preserved', () => {
    const res = mk('AWS::EC2::NetworkInterface', {
      SubnetId: 'subnet-1',
      PrivateIpAddresses: [
        { Primary: true, PrivateIpAddress: '10.0.0.10' },
        { Primary: false, PrivateIpAddress: '10.0.0.200' },
      ],
    });
    // declared list implies 1 secondary; live shows 5 (an out-of-band add) -> surfaces.
    const f = classifyResource(res, { SecondaryPrivateIpAddressCount: 5 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('SecondaryPrivateIpAddressCount');
  });
});

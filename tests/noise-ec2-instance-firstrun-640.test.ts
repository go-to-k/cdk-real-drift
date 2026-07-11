// #640 — EC2 Instance first-run undeclared batch. On a fresh un-mutated launch AWS reads back
// values the template never declared. Only the genuinely CREATE-ONLY items fold value-independent
// (tier 3): CpuOptions (instance-type-derived) and the SubnetId AWS echoes up from a declared
// NetworkInterfaces block — a create-only value cannot drift out of band, so folding it can never
// hide a real change, and it is never user intent when undeclared.
//
// SecurityGroupIds is MUTABLE out of band (`ec2 modify-instance-attribute --groups sg-…` swaps it on
// a running instance with no replacement), so it is NOT folded value-independent (that would HIDE an
// OOB SG swap); instead it goes through the derived VPC-default-SG GATE (#889/#640): fold the single
// VPC-default SG a clean deploy reads back, surface an append or a swap to a non-default SG.
// The rest of the batch now ALSO folds (reaching the zero-first-check invariant), each with detection
// preserved: the name-form `SecurityGroups` folds value-independent because the id-form sibling
// `SecurityGroupIds` above is the canonical swap detector; `Volumes` (pure AWS-assigned identifiers)
// and `BlockDeviceMappings` (the AMI-derived root husk) fold value-independent; `NetworkInterfaces`
// folds the auto-created primary but SURFACES an out-of-band ENI attach (per-element DeviceIndex gate
// in classify.ts). A user who pins any folded item DECLARES it, compared in the declared loop.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const schema = (createOnly: string[] = []): SchemaInfo => ({
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(createOnly),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: createOnly,
  defaults: {},
  defaultPaths: {},
});

const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Host',
  resourceType: 'AWS::EC2::Instance',
  physicalId: 'i-0abc',
  declared,
});

describe('#640 EC2 Instance first-run undeclared folds (value-independent)', () => {
  // A minimal instance that declares nothing about SGs / subnet / CPU / interfaces / volumes,
  // exactly like a fresh clean deploy before `record`.
  const declared = { ImageId: 'ami-1', InstanceType: 't3.micro' };
  const live = {
    ImageId: 'ami-1',
    InstanceType: 't3.micro',
    CpuOptions: { CoreCount: 1, ThreadsPerCore: 2 },
    SecurityGroups: ['MyStack-Sg-nA4Jj877L60k'],
    SecurityGroupIds: ['sg-027bb24dfa8eb1b48'],
    SubnetId: 'subnet-012053df57a833e72',
    NetworkInterfaces: [
      { NetworkInterfaceId: 'eni-0a9b2c526ff5b36ae', DeviceIndex: '0', DeleteOnTermination: true },
    ],
    Volumes: [{ VolumeId: 'vol-094cd4ee2e33c8e54', Device: '/dev/xvda' }],
  };

  // The single VPC-default SG id the clean deploy read back, supplied to the #889/#640 SG gate.
  const defaultSgIds = new Set(['sg-027bb24dfa8eb1b48']);

  it('folds the whole first-run undeclared batch on a clean deploy — ZERO potential drift', () => {
    const fs = classifyResource(mk(declared), structuredClone(live), schema(), { defaultSgIds });
    // Every AWS-auto-created baseline folds atDefault; nothing surfaces as undeclared.
    expect(tier(fs, 'atDefault')).toEqual([
      'CpuOptions',
      'NetworkInterfaces',
      'SecurityGroupIds',
      'SecurityGroups',
      'SubnetId',
      'Volumes',
    ]);
    expect(tier(fs, 'undeclared')).toEqual([]);
  });

  it('NetworkInterfaces SURFACES an out-of-band ENI attach (non-primary DeviceIndex) — detection preserved', () => {
    // A rogue `attach-network-interface` adds a secondary interface at DeviceIndex 1; the per-element
    // gate must SURFACE the whole path (the attach a value-independent fold would hide).
    const attached = {
      ...structuredClone(live),
      NetworkInterfaces: [
        { NetworkInterfaceId: 'eni-primary', DeviceIndex: '0' },
        { NetworkInterfaceId: 'eni-rogue', DeviceIndex: '1' },
      ],
    };
    const fs = classifyResource(mk(declared), attached, schema(), { defaultSgIds });
    expect(tier(fs, 'undeclared')).toContain('NetworkInterfaces');
    expect(tier(fs, 'atDefault')).not.toContain('NetworkInterfaces');
  });

  it('SecurityGroupIds SURFACES on an out-of-band swap to a NON-default SG (detection preserved)', () => {
    // A rogue `modify-instance-attribute --groups` swaps the instance onto a non-default SG. The
    // gate must SURFACE it (undeclared) — this is the OOB SG swap a value-independent fold would hide.
    const swapped = { ...structuredClone(live), SecurityGroupIds: ['sg-0deadbeef00000000'] };
    const fs = classifyResource(mk(declared), swapped, schema(), { defaultSgIds });
    expect(tier(fs, 'undeclared')).toContain('SecurityGroupIds');
  });

  it('WITHOUT the folds every value would surface (guards the regression this fixes)', () => {
    // Sanity: an UNRELATED undeclared key AWS did not fold still surfaces as undeclared, proving
    // the classifier is not blanket-folding the create-only pair everything on this type.
    const fs = classifyResource(
      mk(declared),
      structuredClone({ ...live, SomeNovelOutOfBandKey: 'x' }),
      schema(),
      {}
    );
    expect(tier(fs, 'undeclared')).toContain('SomeNovelOutOfBandKey');
  });

  it('a DECLARED SubnetId / SecurityGroupIds is compared in the declared loop, not folded here', () => {
    // The user pinned the subnet + SGs; a live MISMATCH must still surface as declared drift,
    // proving the value-independent fold only applies to the UNDECLARED case.
    const decl = {
      ...declared,
      SubnetId: 'subnet-declared',
      SecurityGroupIds: ['sg-declared'],
    };
    const drifted = {
      ...live,
      SubnetId: 'subnet-OUT-OF-BAND',
      SecurityGroupIds: ['sg-OUT-OF-BAND'],
    };
    const fs = classifyResource(mk(decl), structuredClone(drifted), schema(), {});
    expect(tier(fs, 'declared')).toEqual(['SecurityGroupIds', 'SubnetId']);
  });
});

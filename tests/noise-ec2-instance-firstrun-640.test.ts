// #640 — EC2 Instance first-run undeclared batch. On a fresh un-mutated launch AWS reads back
// values the template never declared. Only the genuinely CREATE-ONLY items fold value-independent
// (tier 3): CpuOptions (instance-type-derived) and the SubnetId AWS echoes up from a declared
// NetworkInterfaces block — a create-only value cannot drift out of band, so folding it can never
// hide a real change, and it is never user intent when undeclared.
//
// DELIBERATELY NOT folded (a #889 handoff / deferred boundary this test documents): SecurityGroups
// / SecurityGroupIds are MUTABLE out of band (`ec2 modify-instance-attribute --groups sg-…` swaps
// them on a running instance with no replacement), so value-independent would HIDE an OOB SG swap —
// they STILL surface as undeclared drift. NetworkInterfaces / Volumes are likewise deferred (a rogue
// ENI / volume can be attached OOB). A user who pins any folded item DECLARES it, which is then
// compared in the declared loop and does NOT fold here.
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

  it('folds only the create-only CpuOptions + SubnetId to atDefault', () => {
    const fs = classifyResource(mk(declared), structuredClone(live), schema(), {});
    expect(tier(fs, 'atDefault')).toEqual(['CpuOptions', 'SubnetId']);
  });

  it('SecurityGroupIds / SecurityGroups / NetworkInterfaces / Volumes are NOT folded — they still surface as undeclared drift', () => {
    // These four are MUTABLE out of band (an SG swap or a rogue ENI / volume attach on a running
    // instance), so a value-independent fold would HIDE that change. They deliberately do NOT fold
    // here — SecurityGroups/SecurityGroupIds are a #889 handoff, NetworkInterfaces/Volumes deferred.
    const fs = classifyResource(mk(declared), structuredClone(live), schema(), {});
    expect(tier(fs, 'undeclared')).toEqual([
      'NetworkInterfaces',
      'SecurityGroupIds',
      'SecurityGroups',
      'Volumes',
    ]);
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

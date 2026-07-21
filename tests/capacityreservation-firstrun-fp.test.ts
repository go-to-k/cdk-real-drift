// Hunt 2026-07-21 (zerocorpus-hunt, CdkrdHunt0721Zc): a barest AWS::EC2::CapacityReservation
// (only AZ/count/platform/type declared) first-ran SIX [Potential Drift] FPs. Fixes, per the
// fold decision order:
//   - Tenancy "default" / EndDateType "unlimited" / InstanceMatchCriteria "open" and the
//     literal STRING "null" the handler echoes for the absent EndDate -> KNOWN_DEFAULTS
//     (equality-gated constants; an out-of-band `modify-capacity-reservation` still surfaces).
//   - AvailabilityZoneId ("use1-az1") -> value-independent: the per-ACCOUNT zone-id mapping of
//     the declared AZ, an AWS-assigned identifier (createOnly; a user who cares declares
//     AvailabilityZoneId instead, compared in the declared loop).
//   - TagSpecifications -> the handler echoes the create-time INPUT wrapper containing the
//     CFN-propagated STACK tags; subtractPropagatedStackTags now subtracts them inside the
//     wrapper (dropping emptied specs / the emptied wrapper), keeping any non-stack tag.
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
  AvailabilityZone: 'us-east-1a',
  InstanceCount: 1,
  InstancePlatform: 'Linux/UNIX',
  InstanceType: 't3.nano',
};
const mk = (): DesiredResource => ({
  logicalId: 'Cr',
  resourceType: 'AWS::EC2::CapacityReservation',
  physicalId: 'cr-04de13f4a4e83d35e',
  declared,
});
const stackTags = { 'cdkrd:ephemeral': '1' };
// The live model as harvested on the fresh reservation (identifier/read-only members
// trimmed to the classification-relevant surface).
const liveModel = {
  ...declared,
  Tenancy: 'default',
  EndDateType: 'unlimited',
  EndDate: 'null',
  InstanceMatchCriteria: 'open',
  AvailabilityZoneId: 'use1-az1',
  TagSpecifications: [
    {
      ResourceType: 'capacity-reservation',
      Tags: [{ Key: 'cdkrd:ephemeral', Value: '1' }],
    },
  ],
  EbsOptimized: false,
  EphemeralStorage: false,
};

describe('AWS::EC2::CapacityReservation first-run folds (hunt 2026-07-21)', () => {
  it('a barest reservation shows ZERO first-run potential drift', () => {
    const f = classifyResource(mk(), structuredClone(liveModel), emptySchema, { stackTags });
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toContain('Tenancy');
    expect(pathsByTier(f, 'atDefault')).toContain('EndDateType');
    expect(pathsByTier(f, 'atDefault')).toContain('InstanceMatchCriteria');
  });

  it('an out-of-band instance-match-criteria change still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(),
      { ...structuredClone(liveModel), InstanceMatchCriteria: 'targeted' },
      emptySchema,
      { stackTags }
    );
    expect(pathsByTier(f, 'undeclared')).toContain('InstanceMatchCriteria');
  });

  it('an out-of-band end date still surfaces (EndDate pin folds only the "null" echo)', () => {
    const f = classifyResource(
      mk(),
      {
        ...structuredClone(liveModel),
        EndDateType: 'limited',
        EndDate: '2027-01-01T00:00:00Z',
      },
      emptySchema,
      { stackTags }
    );
    const undeclared = pathsByTier(f, 'undeclared');
    expect(undeclared).toContain('EndDateType');
    expect(undeclared).toContain('EndDate');
  });

  it('a NON-stack tag inside the TagSpecifications echo still surfaces', () => {
    const live = structuredClone(liveModel);
    (live.TagSpecifications[0] as { Tags: { Key: string; Value: string }[] }).Tags.push({
      Key: 'rogue',
      Value: 'evil',
    });
    const f = classifyResource(mk(), live, emptySchema, { stackTags });
    expect(pathsByTier(f, 'undeclared')).toContain('TagSpecifications');
  });
});

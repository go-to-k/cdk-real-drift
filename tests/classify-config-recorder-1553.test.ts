// #1553 — AWS::Config::ConfigurationRecorder undeclared AWS-assigned defaults fold to
// atDefault so a freshly deployed recorder is CLEAN, while a real out-of-band change still
// surfaces:
//   - RecordingGroup.RecordingStrategy ({UseOnly:"…"}) is an AWS-DERIVED reflection of the
//     recording group (tier-2 derived, computed from the live sibling RecordingGroup — a
//     constant pin would false-positive on an AllSupported recorder). Its UseOnly is
//     ALL_SUPPORTED_RESOURCE_TYPES when AllSupported, EXCLUSION_BY_RESOURCE_TYPES when an
//     exclusion list is set, else INCLUSION_BY_RESOURCE_TYPES.
//   - RecordingMode defaults to the whole-object constant {RecordingFrequency:"CONTINUOUS"}
//     (KNOWN_DEFAULTS, tier-1) — a switch to DAILY still surfaces.
// The INCLUSION shape is covered by the golden corpus (AWS__Config__ConfigurationRecorder);
// this pins the ALL_SUPPORTED / EXCLUSION branches (a constant pin cannot express them) and
// the detection direction.
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
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Recorder',
  resourceType: 'AWS::Config::ConfigurationRecorder',
  physicalId: 'rec-phys',
  declared,
});

describe('#1553 Config recorder RecordingGroup.RecordingStrategy derived fold', () => {
  it('folds INCLUSION_BY_RESOURCE_TYPES for a resourceTypes recorder', () => {
    const f = classifyResource(
      mk({
        RoleARN: 'role',
        RecordingGroup: { AllSupported: false, ResourceTypes: ['AWS::S3::Bucket'] },
      }),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ResourceTypes: ['AWS::S3::Bucket'],
          RecordingStrategy: { UseOnly: 'INCLUSION_BY_RESOURCE_TYPES' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('RecordingGroup.RecordingStrategy');
    expect(tier(f, 'undeclared')).not.toContain('RecordingGroup.RecordingStrategy');
  });

  it('folds ALL_SUPPORTED_RESOURCE_TYPES for an AllSupported recorder (a constant INCLUSION pin would FP here)', () => {
    const f = classifyResource(
      mk({ RoleARN: 'role', RecordingGroup: { AllSupported: true } }),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: true,
          RecordingStrategy: { UseOnly: 'ALL_SUPPORTED_RESOURCE_TYPES' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('RecordingGroup.RecordingStrategy');
    expect(tier(f, 'undeclared')).not.toContain('RecordingGroup.RecordingStrategy');
  });

  it('folds EXCLUSION_BY_RESOURCE_TYPES for an exclusion recorder', () => {
    const f = classifyResource(
      mk({
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ExclusionByResourceTypes: { ResourceTypes: ['AWS::EC2::Instance'] },
        },
      }),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ExclusionByResourceTypes: { ResourceTypes: ['AWS::EC2::Instance'] },
          RecordingStrategy: { UseOnly: 'EXCLUSION_BY_RESOURCE_TYPES' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('RecordingGroup.RecordingStrategy');
    expect(tier(f, 'undeclared')).not.toContain('RecordingGroup.RecordingStrategy');
  });

  it('surfaces a RecordingStrategy that does NOT match the derived value — detection preserved', () => {
    const f = classifyResource(
      mk({
        RoleARN: 'role',
        RecordingGroup: { AllSupported: false, ResourceTypes: ['AWS::S3::Bucket'] },
      }),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ResourceTypes: ['AWS::S3::Bucket'],
          // Inconsistent with the inclusion group — a value the derivation does not produce.
          RecordingStrategy: { UseOnly: 'ALL_SUPPORTED_RESOURCE_TYPES' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('RecordingGroup.RecordingStrategy');
    expect(tier(f, 'atDefault')).not.toContain('RecordingGroup.RecordingStrategy');
  });
});

describe('#1553 Config recorder RecordingMode default fold', () => {
  const declared = {
    RoleARN: 'role',
    RecordingGroup: { AllSupported: false, ResourceTypes: ['AWS::S3::Bucket'] },
  };
  it('folds the AWS default {RecordingFrequency:"CONTINUOUS"} to atDefault', () => {
    const f = classifyResource(
      mk(declared),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ResourceTypes: ['AWS::S3::Bucket'],
          RecordingStrategy: { UseOnly: 'INCLUSION_BY_RESOURCE_TYPES' },
        },
        RecordingMode: { RecordingFrequency: 'CONTINUOUS' },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('RecordingMode');
    expect(tier(f, 'undeclared')).not.toContain('RecordingMode');
  });
  it('surfaces a DAILY recording mode out of band — detection preserved', () => {
    const f = classifyResource(
      mk(declared),
      {
        RoleARN: 'role',
        RecordingGroup: {
          AllSupported: false,
          ResourceTypes: ['AWS::S3::Bucket'],
          RecordingStrategy: { UseOnly: 'INCLUSION_BY_RESOURCE_TYPES' },
        },
        RecordingMode: { RecordingFrequency: 'DAILY' },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('RecordingMode');
    expect(tier(f, 'atDefault')).not.toContain('RecordingMode');
  });
});

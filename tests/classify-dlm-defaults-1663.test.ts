// #1663: two first-run FPs on a barest AWS::DLM::LifecyclePolicy (the first live fixture
// for this SDK-override reader — both prior corpus cases DECLARED the suspect leaves, the
// #615-class apparent-coverage trap):
// - An interval-based schedule CreateRule that declares no Times reads back a
//   creation-time-assigned start time (`Times: ["03:06"]`, different per resource) —
//   not a constant and not derivable, so it folds via the tier-3 nested value-independent
//   table (a user who cares about the start time declares Times → declared dimension).
// - A default-policy shorthand that declares no RetainInterval reads back the documented
//   constant default 7 — tier-1 equality-gated KNOWN_DEFAULTS, so a retain interval
//   changed out of band still surfaces.
// Live-repro'd 2026-07-17 (us-east-1) on the kmsdlm-hunt fixture; the
// AWS__DLM__LifecyclePolicy.CustomPolicy/DefaultPolicy corpus cases pin both folds.
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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

// The barest custom-policy shape: an interval-based CreateRule with no Times declared.
const customPolicy: DesiredResource = {
  logicalId: 'CustomPolicy',
  resourceType: 'AWS::DLM::LifecyclePolicy',
  physicalId: 'policy-0123456789abcdef0',
  declared: {
    Description: 'custom snapshot policy',
    ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
    State: 'ENABLED',
    PolicyDetails: {
      PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
      ResourceTypes: ['VOLUME'],
      TargetTags: [{ Key: 'cdkrd-hunt', Value: '0717' }],
      Schedules: [
        {
          Name: 'daily',
          CreateRule: { Interval: 12, IntervalUnit: 'HOURS' },
          RetainRule: { Count: 1 },
        },
      ],
    },
  },
};

const customLive = (times: string[]) => ({
  Description: 'custom snapshot policy',
  State: 'ENABLED',
  ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
  PolicyDetails: {
    PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
    ResourceTypes: ['VOLUME'],
    ResourceLocations: ['CLOUD'],
    TargetTags: [{ Key: 'cdkrd-hunt', Value: '0717' }],
    Schedules: [
      {
        Name: 'daily',
        CopyTags: false,
        CreateRule: { Location: 'CLOUD', Interval: 12, IntervalUnit: 'HOURS', Times: times },
        RetainRule: { Count: 1, Interval: 0 },
      },
    ],
    PolicyLanguage: 'STANDARD',
  },
});

// The default-policy shorthand shape (DefaultPolicy itself is a schema readGap — omitted
// here so the empty schema doesn't manufacture an unrelated declared finding).
const shorthandPolicy: DesiredResource = {
  logicalId: 'DefaultPolicy',
  resourceType: 'AWS::DLM::LifecyclePolicy',
  physicalId: 'policy-0fedcba9876543210',
  declared: {
    CreateInterval: 1,
    Description: 'default policy shorthand',
    ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
    State: 'ENABLED',
  },
};

const shorthandLive = (retainInterval: number) => ({
  Description: 'default policy shorthand',
  State: 'ENABLED',
  ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
  CreateInterval: 1,
  RetainInterval: retainInterval,
  CopyTags: false,
  ExtendDeletion: false,
});

describe('#1663 DLM LifecyclePolicy first-run default folds', () => {
  it('folds an undeclared creation-assigned CreateRule.Times to atDefault (value-independent)', () => {
    const f = classifyResource(customPolicy, customLive(['03:06']), emptySchema);
    expect(tierPaths(f)).toEqual([
      'atDefault:PolicyDetails.PolicyLanguage',
      'atDefault:PolicyDetails.ResourceLocations',
      'atDefault:PolicyDetails.Schedules[daily].CreateRule.Location',
      'atDefault:PolicyDetails.Schedules[daily].CreateRule.Times',
      'atDefault:PolicyDetails.Schedules[daily].RetainRule.Interval',
    ]);
  });

  it('folds Times regardless of the assigned value (per-resource, value-independent)', () => {
    const f = classifyResource(customPolicy, customLive(['21:45']), emptySchema);
    expect(tierPaths(f)).toContain('atDefault:PolicyDetails.Schedules[daily].CreateRule.Times');
  });

  it('folds an undeclared shorthand RetainInterval at the documented default 7', () => {
    const f = classifyResource(shorthandPolicy, shorthandLive(7), emptySchema);
    expect(tierPaths(f)).toEqual(['atDefault:RetainInterval']);
  });

  it('still surfaces a RetainInterval changed away from the default (equality-gated)', () => {
    const f = classifyResource(shorthandPolicy, shorthandLive(5), emptySchema);
    expect(tierPaths(f)).toEqual(['undeclared:RetainInterval']);
  });
});

// #1668 — the no-shorthand default-policy shape: the reader now projects the shorthand
// keys top-level, so the undeclared CreateInterval must fold at its documented default 1
// (equality-gated) alongside RetainInterval=7.
describe('#1668 no-shorthand default policy folds', () => {
  const bare: DesiredResource = {
    logicalId: 'DefaultPolicyInstance',
    resourceType: 'AWS::DLM::LifecyclePolicy',
    physicalId: 'policy-0aaa1112223334445',
    declared: {
      Description: 'instance default policy',
      ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
      State: 'ENABLED',
    },
  };
  const live = (createInterval: number) => ({
    Description: 'instance default policy',
    State: 'ENABLED',
    ExecutionRoleArn: 'arn:aws:iam::111111111111:role/DlmRole',
    CreateInterval: createInterval,
    RetainInterval: 7,
    CopyTags: false,
    ExtendDeletion: false,
  });

  it('folds the undeclared CreateInterval at the documented default 1', () => {
    const f = classifyResource(bare, live(1), emptySchema);
    expect(tierPaths(f)).toEqual(['atDefault:CreateInterval', 'atDefault:RetainInterval']);
  });

  it('still surfaces a CreateInterval changed away from the default (equality-gated)', () => {
    const f = classifyResource(bare, live(3), emptySchema);
    expect(tierPaths(f)).toEqual(['atDefault:RetainInterval', 'undeclared:CreateInterval']);
  });
});

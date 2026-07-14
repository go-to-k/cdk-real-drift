// #1612: barest GuardDuty Filter/Detector first-run FPs, live-found 2026-07-14
// (guardduty-hunt):
// - GuardDuty stores short condition keys as their long synonyms (Gte ->
//   GreaterThanOrEqual, Eq -> Equals) -> declared-side canonicalization.
// - Filter Action defaults to NOOP (constant), Rank is AWS-assigned volatile
//   ordering (a sibling filter's create re-ranks every filter -> value-independent).
// - Detector Features: AI_PROTECTION ships DISABLED (joined the
//   GUARDDUTY_FEATURE_CREATION_STATUS map).
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

const filterRes: DesiredResource = {
  logicalId: 'HuntFilter',
  resourceType: 'AWS::GuardDuty::Filter',
  physicalId: 'cdkrd-hunt0714-filter',
  declared: {
    DetectorId: 'd1',
    Name: 'cdkrd-hunt0714-filter',
    FindingCriteria: { Criterion: { severity: { Gte: 4 }, type: { Eq: ['Recon:EC2/Foo'] } } },
  },
};
const filterLive = (sev: number) => ({
  DetectorId: 'd1',
  Name: 'cdkrd-hunt0714-filter',
  FindingCriteria: {
    Criterion: { severity: { GreaterThanOrEqual: sev }, type: { Equals: ['Recon:EC2/Foo'] } },
  },
  Action: 'NOOP',
  Rank: 1,
});

describe('GuardDuty::Filter criterion key aliases + Action/Rank defaults (#1612)', () => {
  it('folds the long-form echo of declared short keys + Action/Rank on a clean deploy', () => {
    const f = classifyResource(filterRes, filterLive(4), emptySchema);
    expect(tier(f, 'declared')).toEqual([]);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('Action');
  });
  it('still detects a REAL out-of-band criterion change through the alias', () => {
    const f = classifyResource(filterRes, filterLive(8), emptySchema);
    expect(tier(f, 'declared').some((p) => p.includes('severity'))).toBe(true);
  });
  it('surfaces an out-of-band Action switch to ARCHIVE — detection preserved', () => {
    const f = classifyResource(filterRes, { ...filterLive(4), Action: 'ARCHIVE' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('Action');
  });
  it('leaves a template that already declares the long form untouched', () => {
    const longRes: DesiredResource = {
      ...filterRes,
      declared: {
        DetectorId: 'd1',
        Name: 'cdkrd-hunt0714-filter',
        FindingCriteria: { Criterion: { severity: { GreaterThanOrEqual: 4 } } },
      },
    };
    const f = classifyResource(
      longRes,
      {
        DetectorId: 'd1',
        Name: 'cdkrd-hunt0714-filter',
        FindingCriteria: { Criterion: { severity: { GreaterThanOrEqual: 4 } } },
        Action: 'NOOP',
        Rank: 1,
      },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual([]);
  });
});

describe('GuardDuty::Detector Features — AI_PROTECTION ships DISABLED (#1612)', () => {
  const detRes: DesiredResource = {
    logicalId: 'HuntDetector',
    resourceType: 'AWS::GuardDuty::Detector',
    physicalId: 'd1',
    declared: { Enable: true },
  };
  const features = (aiProtStatus: string, s3Status = 'ENABLED') => [
    { Status: 'ENABLED', Name: 'CLOUD_TRAIL' },
    { Status: s3Status, Name: 'S3_DATA_EVENTS' },
    { Status: aiProtStatus, Name: 'AI_PROTECTION' },
    { Status: 'DISABLED', Name: 'AI_ANALYST' },
  ];
  it('folds a fresh detector whose AI_PROTECTION is DISABLED at creation', () => {
    const f = classifyResource(
      detRes,
      { Enable: true, Features: features('DISABLED') },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('Features');
  });
  it('still surfaces an out-of-band disable of a default-ENABLED protection', () => {
    const f = classifyResource(
      detRes,
      { Enable: true, Features: features('DISABLED', 'DISABLED') },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('Features');
  });
});

// #1535 — a barest on-demand MediaConvert Queue / JobTemplate first-run-FP'd five
// creation-time constants (the #497 SDK-override readers were never exercised barest):
//   * Queue:       PricingPlan "ON_DEMAND", Status "ACTIVE"
//   * JobTemplate: Priority 0, StatusUpdateInterval "SECONDS_60",
//                  AccelerationSettings {Mode:"DISABLED"}
// All stable constants → fold-strategy tier 1 (KNOWN_DEFAULTS, equality-gated): each folds
// the exact default and still surfaces any change away from it — `Status` is the classic
// console-pause, live-verified both directions on CdkrdHunt0713MediaConv (us-east-1,
// 2026-07-13): fresh deploy folds CLEAN, an out-of-band PAUSED re-surfaces.
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

const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Hunt',
  resourceType,
  physicalId: 'cdkrd-hunt-mc',
  declared,
});

describe('#1535 MediaConvert Queue constant defaults', () => {
  const declared = { Name: 'cdkrd-hunt-mc-queue' };

  it('folds undeclared PricingPlan/Status creation defaults to atDefault (zero first-run noise)', () => {
    const f = classifyResource(
      mk('AWS::MediaConvert::Queue', declared),
      { ...declared, PricingPlan: 'ON_DEMAND', Status: 'ACTIVE' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(['PricingPlan', 'Status']);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('an out-of-band PAUSED queue still surfaces (equality gate keeps detection)', () => {
    const f = classifyResource(
      mk('AWS::MediaConvert::Queue', declared),
      { ...declared, PricingPlan: 'ON_DEMAND', Status: 'PAUSED' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['Status']);
    expect(pathsByTier(f, 'atDefault')).toEqual(['PricingPlan']);
  });
});

describe('#1535 MediaConvert JobTemplate constant defaults', () => {
  const declared = { Name: 'cdkrd-hunt-mc-jobtemplate' };

  it('folds undeclared Priority/StatusUpdateInterval/AccelerationSettings to atDefault', () => {
    const f = classifyResource(
      mk('AWS::MediaConvert::JobTemplate', declared),
      {
        ...declared,
        Priority: 0,
        StatusUpdateInterval: 'SECONDS_60',
        AccelerationSettings: { Mode: 'DISABLED' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual([
      'AccelerationSettings',
      'Priority',
      'StatusUpdateInterval',
    ]);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a non-default priority / enabled acceleration still surfaces', () => {
    const f = classifyResource(
      mk('AWS::MediaConvert::JobTemplate', declared),
      {
        ...declared,
        Priority: 50,
        StatusUpdateInterval: 'SECONDS_60',
        AccelerationSettings: { Mode: 'ENABLED' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['AccelerationSettings', 'Priority']);
    expect(pathsByTier(f, 'atDefault')).toEqual(['StatusUpdateInterval']);
  });
});

// #1526 / #1528 — barest-config first-run false positives on MediaConvert Queue / JobTemplate
// and SageMaker Model, live-observed 2026-07-12 (us-east-1, fresh un-mutated deploys; the
// SDK_OVERRIDES readers for the MediaConvert pair had zero corpus cases and zero fixtures):
//
//   HuntQueue.PricingPlan                       actual ="ON_DEMAND"
//   HuntQueue.Status                            actual ="ACTIVE"
//   HuntJobTemplate.Priority                    actual =0
//   HuntJobTemplate.StatusUpdateInterval        actual ="SECONDS_60"
//   HuntJobTemplate.AccelerationSettings        actual ={"Mode":"DISABLED"}
//   HuntModel.PrimaryContainer.Mode             actual ="SingleModel"
//
// All are AWS creation defaults for properties the template never declares, so they fold as
// equality-gated constants (KNOWN_DEFAULTS / KNOWN_DEFAULT_PATHS) — an out-of-band change away
// from any default (a console queue pause, a priority bump, a MultiModel flip) still surfaces.
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

const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'hunt-res'
): DesiredResource => ({ logicalId: 'Hunt', resourceType, physicalId, declared });

describe('#1526 MediaConvert barest first-run defaults fold', () => {
  it('folds an undeclared Queue PricingPlan=ON_DEMAND / Status=ACTIVE to atDefault', () => {
    const declared = { Name: 'cdkrd-hunt-mc-queue' };
    const f = classifyResource(
      mk('AWS::MediaConvert::Queue', declared),
      { ...declared, PricingPlan: 'ON_DEMAND', Status: 'ACTIVE' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(['PricingPlan', 'Status']);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('still surfaces the classic out-of-band console pause (Status=PAUSED)', () => {
    const declared = { Name: 'cdkrd-hunt-mc-queue' };
    const f = classifyResource(
      mk('AWS::MediaConvert::Queue', declared),
      { ...declared, PricingPlan: 'ON_DEMAND', Status: 'PAUSED' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['Status']);
    expect(pathsByTier(f, 'atDefault')).toEqual(['PricingPlan']);
  });

  it('folds the undeclared JobTemplate Priority/StatusUpdateInterval/AccelerationSettings trio', () => {
    const declared = { Name: 'cdkrd-hunt-mc-jobtemplate', SettingsJson: { OutputGroups: [] } };
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

  it('still surfaces an out-of-band JobTemplate change away from each default', () => {
    const declared = { Name: 'cdkrd-hunt-mc-jobtemplate', SettingsJson: { OutputGroups: [] } };
    const f = classifyResource(
      mk('AWS::MediaConvert::JobTemplate', declared),
      {
        ...declared,
        Priority: 25,
        StatusUpdateInterval: 'SECONDS_10',
        AccelerationSettings: { Mode: 'ENABLED' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([
      'AccelerationSettings',
      'Priority',
      'StatusUpdateInterval',
    ]);
  });
});

describe('#1528 SageMaker Model undeclared container Mode fold', () => {
  const declared = {
    ExecutionRoleArn: 'arn:aws:iam::123456789012:role/hunt-role',
    PrimaryContainer: { Image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/img:1' },
  };

  it('folds an undeclared PrimaryContainer.Mode=SingleModel to atDefault (fresh deploy)', () => {
    const f = classifyResource(
      mk('AWS::SageMaker::Model', declared),
      {
        ...declared,
        PrimaryContainer: { ...declared.PrimaryContainer, Mode: 'SingleModel' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('PrimaryContainer.Mode');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('still surfaces an out-of-band MultiModel flip', () => {
    const f = classifyResource(
      mk('AWS::SageMaker::Model', declared),
      {
        ...declared,
        PrimaryContainer: { ...declared.PrimaryContainer, Mode: 'MultiModel' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['PrimaryContainer.Mode']);
  });
});

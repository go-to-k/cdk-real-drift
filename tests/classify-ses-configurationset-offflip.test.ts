// Hunt 2026-07-14 (revconv5 batch): an out-of-band DISABLE of an SES ConfigurationSet's
// SendingOptions.SendingEnabled or ReputationOptions.ReputationMetricsEnabled was invisible —
// both KNOWN_DEFAULTS whole-object pins flip ALL-FALSE, which isTrivialEmpty swallowed before
// the pin gate (the GuardDuty DataSources shape, #1092). Live-proven on a fresh barest set
// (us-east-1, stack CdkrdHuntRevconv5): `put-configuration-set-sending-options
// --no-sending-enabled` + the reputation twin left `check --fail` at exit 0 while the Cloud
// Control read carried both `false` leaves. The paired MEANINGFUL_WHEN_OFF entries surface
// them; the clean-deploy `true` shapes must still fold atDefault (no new first-run FP).
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

describe('SES ConfigurationSet sending/reputation off-flips (hunt 2026-07-14)', () => {
  const res: DesiredResource = {
    logicalId: 'SesCs',
    resourceType: 'AWS::SES::ConfigurationSet',
    physicalId: 'cdkrd-hunt-revconv5-cs',
    declared: { Name: 'cdkrd-hunt-revconv5-cs' },
  };
  // The live Cloud Control read shape (copied from the 2026-07-14 live probe).
  const live = (sending: boolean, reputation: boolean) => ({
    Name: 'cdkrd-hunt-revconv5-cs',
    SendingOptions: { SendingEnabled: sending },
    ReputationOptions: { ReputationMetricsEnabled: reputation },
  });

  it('folds the clean-deploy true shapes to atDefault (first-run stays CLEAN)', () => {
    const f = classifyResource(res, live(true, true), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['ReputationOptions', 'SendingOptions'])
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band --no-sending-enabled (the live-proven FN)', () => {
    const f = classifyResource(res, live(false, true), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['SendingOptions']);
    expect(pathsByTier(f, 'atDefault')).toContain('ReputationOptions');
  });

  it('surfaces an out-of-band --no-reputation-metrics-enabled', () => {
    const f = classifyResource(res, live(true, false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['ReputationOptions']);
    expect(pathsByTier(f, 'atDefault')).toContain('SendingOptions');
  });

  it('surfaces both when both are disabled out of band', () => {
    const f = classifyResource(res, live(false, false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['ReputationOptions', 'SendingOptions']);
  });
});

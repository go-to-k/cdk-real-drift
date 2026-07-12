// #660 item 3 (nested MEANINGFUL_WHEN_OFF): an Athena WorkGroup declares no
// WorkGroupConfiguration, so the object is DESCENDED leaf-by-leaf
// (DESCEND_UNDECLARED_OBJECT_PATHS). Its `EnforceWorkGroupConfiguration` and
// `PublishCloudWatchMetricsEnabled` `true` defaults fold atDefault via KNOWN_DEFAULT_PATHS
// on a clean deploy, but an out-of-band `update-work-group` flipping either `false` would be
// swallowed by isTrivialEmpty(false) BEFORE the pin gate — invisible. The nested off-state
// twin surfaces the disable as `undeclared` while the clean `true` still folds. Live-verified
// A/B 2026-07-12 on `Cdkrd660AthenaVerify` (base blind, fix surfaces `actual=false`).
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

describe('#660 Athena WorkGroup nested off-flip (EnforceWorkGroupConfiguration / PublishCloudWatchMetricsEnabled)', () => {
  // A workgroup that declares NO WorkGroupConfiguration — AWS materializes the whole default
  // config, which DESCENDS leaf-by-leaf (DESCEND_UNDECLARED_OBJECT_PATHS).
  const res: DesiredResource = {
    logicalId: 'Wg',
    resourceType: 'AWS::Athena::WorkGroup',
    physicalId: 'cdkrd-660-athena',
    declared: { Name: 'cdkrd-660-athena', State: 'ENABLED' },
  };
  const live = (over: { enforce?: unknown; publish?: unknown }) => ({
    Name: 'cdkrd-660-athena',
    State: 'ENABLED',
    WorkGroupConfiguration: {
      EnforceWorkGroupConfiguration: over.enforce ?? true,
      EngineVersion: { SelectedEngineVersion: 'AUTO' },
      PublishCloudWatchMetricsEnabled: over.publish ?? true,
      RequesterPaysEnabled: false,
    },
  });
  const ENFORCE = 'WorkGroupConfiguration.EnforceWorkGroupConfiguration';
  const PUBLISH = 'WorkGroupConfiguration.PublishCloudWatchMetricsEnabled';

  it('folds the undeclared WorkGroupConfiguration defaults to atDefault (zero first-run drift)', () => {
    // A clean workgroup whose whole default config matches folds the object atDefault as ONE
    // entry (the off-flips below break that equality and descend leaf-by-leaf).
    const f = classifyResource(res, live({}), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('WorkGroupConfiguration');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band undeclared EnforceWorkGroupConfiguration=false disable (#660)', () => {
    const f = classifyResource(res, live({ enforce: false }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(ENFORCE);
    // The sibling default still folds — only the disabled flag surfaces.
    expect(pathsByTier(f, 'atDefault')).toContain(PUBLISH);
  });

  it('surfaces an out-of-band undeclared PublishCloudWatchMetricsEnabled=false disable (#660)', () => {
    const f = classifyResource(res, live({ publish: false }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(PUBLISH);
    expect(pathsByTier(f, 'atDefault')).toContain(ENFORCE);
  });
});

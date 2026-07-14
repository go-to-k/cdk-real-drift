// Post-update echo FP (the #1569 class) on AWS::Events::EventBus: a custom bus
// reads back NO LogConfig on a fresh create, but the first stack UPDATE (any
// harmless change) materializes the logging-disabled default
// {"IncludeDetail":"NONE","Level":"OFF"} undeclared — an AWS-assigned default,
// not a divergence, so it must fold to atDefault. Live-found on the 2026-07-14
// hunt (second-deploy-echo2 fixture, stack CdkrdHuntEcho2v0714).
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

const res: DesiredResource = {
  logicalId: 'Echo2Bus0714',
  resourceType: 'AWS::Events::EventBus',
  physicalId: 'cdkrd-echo2-bus-0714',
  declared: { Name: 'cdkrd-echo2-bus-0714' },
};

describe('Events::EventBus LogConfig (post-update echo, equality-gated constant)', () => {
  it('folds the logging-disabled default materialized by the first update', () => {
    const f = classifyResource(
      res,
      { Name: 'cdkrd-echo2-bus-0714', LogConfig: { IncludeDetail: 'NONE', Level: 'OFF' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('LogConfig');
    expect(tier(f, 'undeclared')).not.toContain('LogConfig');
  });
  it('surfaces out-of-band-enabled bus logging — detection preserved', () => {
    const f = classifyResource(
      res,
      { Name: 'cdkrd-echo2-bus-0714', LogConfig: { IncludeDetail: 'FULL', Level: 'INFO' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('LogConfig');
  });
});

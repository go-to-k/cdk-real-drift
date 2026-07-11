// #1487 — an ON_DEMAND Kinesis stream first-run FP: `ShardCount` cannot be declared together with
// `StreamMode: ON_DEMAND` (CloudFormation rejects the pair), so the undeclared live `ShardCount`
// (4 today, auto-scaled with traffic) can never be user intent. Fold it value-independently,
// gated on the effective `StreamModeDetails.StreamMode` being ON_DEMAND. A PROVISIONED stream
// declares `ShardCount` and is compared in the declared loop (unchanged).
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
const mk = (
  declared: Record<string, unknown>,
  physicalId = 'HuntOnDemandStream'
): DesiredResource => ({
  logicalId: 'HuntOnDemandStream',
  resourceType: 'AWS::Kinesis::Stream',
  physicalId,
  declared,
});

describe('#1487 Kinesis ON_DEMAND stream undeclared ShardCount', () => {
  it('folds the undeclared ShardCount to atDefault for an ON_DEMAND stream (declared sibling)', () => {
    // The harvested live model of a barest `CfnStream({ streamModeDetails: { streamMode: "ON_DEMAND" } })`.
    const f = classifyResource(
      mk({ StreamModeDetails: { StreamMode: 'ON_DEMAND' } }),
      { StreamModeDetails: { StreamMode: 'ON_DEMAND' }, ShardCount: 4 },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('ShardCount');
    expect(tier(f, 'undeclared')).not.toContain('ShardCount');
  });

  it('folds regardless of the specific shard count (value-independent — AWS auto-scales it)', () => {
    const f = classifyResource(
      mk({ StreamModeDetails: { StreamMode: 'ON_DEMAND' } }),
      { StreamModeDetails: { StreamMode: 'ON_DEMAND' }, ShardCount: 17 },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('ShardCount');
    expect(tier(f, 'undeclared')).not.toContain('ShardCount');
  });

  it('derives ON_DEMAND from the LIVE StreamModeDetails when the stream declares none', () => {
    const f = classifyResource(
      mk({}),
      { StreamModeDetails: { StreamMode: 'ON_DEMAND' }, ShardCount: 4 },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('ShardCount');
    expect(tier(f, 'undeclared')).not.toContain('ShardCount');
  });

  it('does NOT fold an undeclared ShardCount when the stream is PROVISIONED — detection preserved', () => {
    // A PROVISIONED stream that omits ShardCount cannot exist, but assert the gate is mode-scoped:
    // an undeclared ShardCount reaching classify under PROVISIONED must still surface.
    const f = classifyResource(
      mk({ StreamModeDetails: { StreamMode: 'PROVISIONED' } }),
      { StreamModeDetails: { StreamMode: 'PROVISIONED' }, ShardCount: 4 },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('ShardCount');
    expect(tier(f, 'atDefault')).not.toContain('ShardCount');
  });

  it('compares a DECLARED ShardCount in the declared dimension (provisioned path unchanged)', () => {
    const f = classifyResource(mk({ ShardCount: 2 }), { ShardCount: 5 }, emptySchema);
    expect(tier(f, 'declared')).toContain('ShardCount');
    expect(tier(f, 'atDefault')).not.toContain('ShardCount');
  });
});

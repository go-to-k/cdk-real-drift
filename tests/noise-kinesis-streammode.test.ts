// Barest PROVISIONED Kinesis stream first-run FP: a stream that declares only
// ShardCount reads back the materialized StreamModeDetails creation default
// ({"StreamMode":"PROVISIONED"}) — an AWS-assigned default, not a divergence, so
// it must fold to atDefault (the inverse of #1487, where ON_DEMAND materializes
// ShardCount). Live-found on the 2026-07-14 hunt (stack CdkrdHuntEcho0714).
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
  logicalId: 'EchoStream0714',
  resourceType: 'AWS::Kinesis::Stream',
  physicalId: 'phys',
  declared: { ShardCount: 1 },
};

describe('Kinesis::Stream StreamModeDetails (equality-gated constant)', () => {
  it('folds the PROVISIONED creation default on a clean deploy', () => {
    const f = classifyResource(
      res,
      { ShardCount: 1, StreamModeDetails: { StreamMode: 'PROVISIONED' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('StreamModeDetails');
    expect(tier(f, 'undeclared')).not.toContain('StreamModeDetails');
  });
  it('surfaces an out-of-band switch to ON_DEMAND — detection preserved', () => {
    const f = classifyResource(
      res,
      { ShardCount: 1, StreamModeDetails: { StreamMode: 'ON_DEMAND' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('StreamModeDetails');
  });
  it('compares a DECLARED StreamModeDetails in the declared dimension (unaffected)', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: { ShardCount: 1, StreamModeDetails: { StreamMode: 'PROVISIONED' } },
    };
    const f = classifyResource(
      declaredRes,
      { ShardCount: 1, StreamModeDetails: { StreamMode: 'ON_DEMAND' } },
      emptySchema
    );
    expect(tier(f, 'declared')).toContain('StreamModeDetails.StreamMode');
  });
});

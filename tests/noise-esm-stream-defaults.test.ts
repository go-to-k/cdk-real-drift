// #1608: a barest STREAM-source EventSourceMapping (DynamoDB Streams / Kinesis —
// FunctionName + EventSourceArn + StartingPosition only) materializes the
// stream-only defaults ParallelizationFactor=1 and TumblingWindowInSeconds=0,
// which must fold to atDefault on a clean deploy (they are AWS-assigned
// defaults, not divergences). SQS sources never carry either prop.
// Live-found on the 2026-07-14 hunt (esm-hunt, CdkrdHunt0714Esm).
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
  logicalId: 'HuntDdbEsm',
  resourceType: 'AWS::Lambda::EventSourceMapping',
  physicalId: 'esm-uuid',
  declared: {
    FunctionName: 'huntfn',
    EventSourceArn: 'arn:aws:dynamodb:us-east-1:111122223333:table/t/stream/2026',
    StartingPosition: 'LATEST',
  },
};
const cleanLive = {
  FunctionName: 'huntfn',
  EventSourceArn: 'arn:aws:dynamodb:us-east-1:111122223333:table/t/stream/2026',
  StartingPosition: 'LATEST',
  ParallelizationFactor: 1,
  TumblingWindowInSeconds: 0,
};

describe('Lambda::EventSourceMapping stream-source defaults (equality-gated constants)', () => {
  it('folds ParallelizationFactor=1 and TumblingWindowInSeconds=0 on a clean deploy', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('ParallelizationFactor');
    expect(tier(f, 'atDefault')).toContain('TumblingWindowInSeconds');
  });
  it('surfaces an out-of-band parallelization raise — detection preserved', () => {
    const f = classifyResource(res, { ...cleanLive, ParallelizationFactor: 5 }, emptySchema);
    expect(tier(f, 'undeclared')).toEqual(['ParallelizationFactor']);
  });
  it('surfaces an out-of-band tumbling window — detection preserved', () => {
    const f = classifyResource(res, { ...cleanLive, TumblingWindowInSeconds: 30 }, emptySchema);
    expect(tier(f, 'undeclared')).toEqual(['TumblingWindowInSeconds']);
  });
  it('compares a DECLARED ParallelizationFactor in the declared dimension (unaffected)', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: { ...res.declared, ParallelizationFactor: 4 },
    };
    const f = classifyResource(declaredRes, cleanLive, emptySchema);
    expect(tier(f, 'declared')).toContain('ParallelizationFactor');
  });
});

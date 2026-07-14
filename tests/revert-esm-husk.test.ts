// #1611: every stream-source EventSourceMapping with no failure destination echoes the
// empty husk `DestinationConfig: {OnFailure: {}}` on read, and the CC update handler
// folds that read-back into ANY patch — Lambda rejects it ("The Destination field is
// required for an OnFailure configuration"), so every revert on the type failed.
// The husk must be stripped from the patch (the #650 EventInvokeConfig class).
import { describe, expect, it } from 'vite-plus/test';
import { type PatchOp, rejectedEmptyStripOps } from '../src/revert/plan.js';

const T = 'AWS::Lambda::EventSourceMapping';
const revertOp: PatchOp = { op: 'remove', path: '/ParallelizationFactor', human: 'x' };

describe('EventSourceMapping DestinationConfig.OnFailure husk strip (#1611)', () => {
  it('strips the empty OnFailure husk the live read echoes', () => {
    const live = {
      ParallelizationFactor: 5,
      DestinationConfig: { OnFailure: {} },
    };
    const strip = rejectedEmptyStripOps(T, [revertOp], live);
    expect(strip).toHaveLength(1);
    expect(strip[0]).toMatchObject({ op: 'remove', path: '/DestinationConfig/OnFailure' });
  });
  it('never strips a REAL failure destination', () => {
    const live = {
      ParallelizationFactor: 5,
      DestinationConfig: { OnFailure: { Destination: 'arn:aws:sqs:us-east-1:1:dlq' } },
    };
    expect(rejectedEmptyStripOps(T, [revertOp], live)).toEqual([]);
  });
  it('no-op when the husk is absent (an SQS-source mapping)', () => {
    expect(rejectedEmptyStripOps(T, [revertOp], { BatchSize: 10 })).toEqual([]);
  });
});

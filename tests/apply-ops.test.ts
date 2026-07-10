import { describe, expect, it } from 'vite-plus/test';
import { applyOps } from '../src/revert/apply-ops.js';
import type { PatchOp } from '../src/revert/plan.js';

const op = (o: Partial<PatchOp>): PatchOp => ({ op: 'add', path: '/X', human: '', ...o });

describe('applyOps (reconstruct desired model for SDK writers)', () => {
  it('add sets a top-level value (replacing)', () => {
    expect(applyOps({ A: 1 }, [op({ op: 'add', path: '/A', value: 2 })])).toEqual({ A: 2 });
  });

  it('add creates + sets a nested path', () => {
    expect(applyOps({}, [op({ op: 'add', path: '/A/B', value: 9 })])).toEqual({ A: { B: 9 } });
  });

  it('remove deletes a key', () => {
    expect(applyOps({ A: 1, B: 2 }, [op({ op: 'remove', path: '/B' })])).toEqual({ A: 1 });
  });

  it('does not mutate the input model', () => {
    const model = { A: { B: 1 } };
    applyOps(model, [op({ op: 'add', path: '/A/B', value: 2 })]);
    expect(model).toEqual({ A: { B: 1 } });
  });

  it('applies multiple ops in order', () => {
    const out = applyOps({ Statement: [{ Effect: 'Allow' }] }, [
      op({ op: 'add', path: '/Version', value: '2012-10-17' }),
      op({ op: 'add', path: '/Statement/0/Effect', value: 'Deny' }),
    ]);
    expect(out).toEqual({ Version: '2012-10-17', Statement: [{ Effect: 'Deny' }] });
  });
});

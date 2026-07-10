import { describe, expect, it } from 'vite-plus/test';
import { applyOps, assertPriorUnchanged, StaleRevertModelError } from '../src/revert/apply-ops.js';
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

describe('assertPriorUnchanged (#805 stale-index guard before a whole-document write)', () => {
  // A canonically-sorted policy: Statement is sorted by Sid, so index 1 is Sid "b".
  const freshPolicy = () => ({
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'a', Effect: 'Allow', Resource: 'arnA' },
        { Sid: 'b', Effect: 'Allow', Resource: 'arnB' },
      ],
    },
  });

  it('passes when the fresh model still holds each op prior at its path', () => {
    // Reverting Sid "b"'s Resource; prior is what check saw at that index, still there.
    expect(() =>
      assertPriorUnchanged(freshPolicy(), [
        op({
          op: 'add',
          path: '/PolicyDocument/Statement/1/Resource',
          value: 'arnB',
          prior: 'arnB',
        }),
      ])
    ).not.toThrow();
  });

  it('throws StaleRevertModelError when a statement was added/removed so the sorted index now points elsewhere', () => {
    // At check time index 1 (sorted) was Sid "b" with Resource 'arnB' (the op prior).
    // A statement inserted at the confirm prompt re-sorts the array so index 1 is now a
    // DIFFERENT statement (Resource 'arnX') — writing 'arnB' there would corrupt it.
    const shifted = {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'a', Effect: 'Allow', Resource: 'arnA' },
          { Sid: 'aa', Effect: 'Deny', Resource: 'arnX' },
          { Sid: 'b', Effect: 'Allow', Resource: 'arnB' },
        ],
      },
    };
    expect(() =>
      assertPriorUnchanged(shifted, [
        op({
          op: 'add',
          path: '/PolicyDocument/Statement/1/Resource',
          value: 'arnB',
          prior: 'arnB',
        }),
      ])
    ).toThrow(StaleRevertModelError);
  });

  it('throws when the value at a top-level path changed since check (whole-document drift)', () => {
    expect(() =>
      assertPriorUnchanged(
        { PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny' }] } },
        [
          op({
            op: 'add',
            path: '/PolicyDocument',
            value: {},
            prior: { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] },
          }),
        ]
      )
    ).toThrow(StaleRevertModelError);
  });

  it('skips ops with no prior (a re-add of a live-removed value has nothing to protect)', () => {
    expect(() =>
      assertPriorUnchanged({ A: 1 }, [op({ op: 'add', path: '/B', value: 2 })])
    ).not.toThrow();
  });

  it('deep-compares object priors so a same-shape live value passes', () => {
    expect(() =>
      assertPriorUnchanged({ Env: { KEY: 'v' } }, [
        op({ op: 'add', path: '/Env', value: { KEY: 'w' }, prior: { KEY: 'v' } }),
      ])
    ).not.toThrow();
  });
});

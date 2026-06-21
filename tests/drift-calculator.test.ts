import { describe, expect, it } from 'vite-plus/test';
import { calculateResourceDrift, deepEqual } from '../src/diff/drift-calculator.js';

describe('calculateResourceDrift', () => {
  it('only walks declared (state) keys; ignores extra aws keys', () => {
    const d = calculateResourceDrift({ A: 1 }, { A: 1, B: 2 });
    expect(d).toEqual([]);
  });

  it('reports nested leaf with dotted path', () => {
    const d = calculateResourceDrift({ V: { Status: 'Enabled' } }, { V: { Status: 'Suspended' } });
    expect(d).toEqual([{ path: 'V.Status', stateValue: 'Enabled', awsValue: 'Suspended' }]);
  });

  it('reports whole-array drift on a single parent path (length change)', () => {
    const d = calculateResourceDrift({ L: ['a'] }, { L: ['a', 'b'] });
    expect(d).toEqual([{ path: 'L', stateValue: ['a'], awsValue: ['a', 'b'] }]);
  });

  it('same-length array of objects: AWS-enriched element is NOT drift (subset)', () => {
    const d = calculateResourceDrift(
      { Enc: [{ SSE: { Alg: 'AES256' } }] },
      { Enc: [{ BucketKeyEnabled: false, SSE: { Alg: 'AES256' } }] }
    );
    expect(d).toEqual([]);
  });

  it('same-length array of objects: a CHANGED declared sub-value IS drift', () => {
    const d = calculateResourceDrift(
      { Enc: [{ SSE: { Alg: 'AES256' } }] },
      { Enc: [{ SSE: { Alg: 'aws:kms' } }] }
    );
    expect(d).toEqual([{ path: 'Enc.0.SSE.Alg', stateValue: 'AES256', awsValue: 'aws:kms' }]);
  });

  it('declared key absent in aws surfaces as drift with undefined actual', () => {
    const d = calculateResourceDrift({ A: 1 }, {});
    expect(d).toEqual([{ path: 'A', stateValue: 1, awsValue: undefined }]);
  });

  it('a free-form map with a DOT in a key is emitted whole at the parent (no corrupt path)', () => {
    // A Docker label "com.example.x" would otherwise build the path
    // "DockerLabels.com.example.x", which toPointer / baseline / ignore re-split wrong.
    const d = calculateResourceDrift(
      { DockerLabels: { 'com.example.x': 'a', plain: 'p' } },
      { DockerLabels: { 'com.example.x': 'b', plain: 'p' } }
    );
    expect(d).toEqual([
      {
        path: 'DockerLabels',
        stateValue: { 'com.example.x': 'a', plain: 'p' },
        awsValue: { 'com.example.x': 'b', plain: 'p' },
      },
    ]);
  });

  it('a key containing [ or ] is also treated as path-unsafe', () => {
    const d = calculateResourceDrift({ Tags: { 'a[0]': 'x' } }, { Tags: { 'a[0]': 'y' } });
    expect(d).toEqual([{ path: 'Tags', stateValue: { 'a[0]': 'x' }, awsValue: { 'a[0]': 'y' } }]);
  });

  it('a map with only path-SAFE keys still descends per key (unchanged behavior)', () => {
    const d = calculateResourceDrift(
      { Variables: { FOO: '1', BAR: '2' } },
      { Variables: { FOO: '1', BAR: '9' } }
    );
    expect(d).toEqual([{ path: 'Variables.BAR', stateValue: '2', awsValue: '9' }]);
  });

  it('ignorePaths skips a subtree', () => {
    const d = calculateResourceDrift(
      { Code: { S3Key: 'x' } },
      { Code: { S3Key: 'y' } },
      { ignorePaths: ['Code'] }
    );
    expect(d).toEqual([]);
  });

  it('deepEqual treats arrays + objects structurally', () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  describe('mutually-exclusive / disjoint-key object swap (union one-of fields)', () => {
    it('emits the WHOLE object (not a leaf) when desired + live share no keys', () => {
      // WAFv2 DefaultAction: desired {Allow:{}} vs live {Block:{}} — a one-of union.
      // Descending would emit `DefaultAction.Allow` (add) and never remove live Block,
      // so a revert leaves BOTH. Emit the whole object so the revert REPLACES it.
      const d = calculateResourceDrift(
        { DefaultAction: { Allow: {} } },
        { DefaultAction: { Block: {} } }
      );
      expect(d).toEqual([
        { path: 'DefaultAction', stateValue: { Allow: {} }, awsValue: { Block: {} } },
      ]);
    });

    it('still descends (subset semantics) when keys OVERLAP', () => {
      // common key `Mode` → descend as before; the extra desired key is an add, the
      // live-only key is left to collectNestedUndeclared (not this calculator).
      const d = calculateResourceDrift(
        { Cfg: { Mode: 'A', Extra: 1 } },
        { Cfg: { Mode: 'B', Other: 9 } }
      );
      expect(d).toEqual([
        { path: 'Cfg.Mode', stateValue: 'A', awsValue: 'B' },
        { path: 'Cfg.Extra', stateValue: 1, awsValue: undefined },
      ]);
    });

    it('an empty desired or empty live object is not treated as a disjoint swap', () => {
      // empty desired {} vs live {X:1}: nothing declared to compare -> no drift (subset).
      expect(calculateResourceDrift({ P: {} }, { P: { X: 1 } })).toEqual([]);
    });
  });
});

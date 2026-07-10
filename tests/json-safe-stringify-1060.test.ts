// #1060 — the top-level `--json` emit in runCheck (`console.log(safeStringifyJson(...))`)
// runs AFTER the per-stack loop, OUTSIDE any try/catch. A non-serializable finding value
// (a BigInt, a circular reference) that survived the per-stack try used to detonate the
// bare `JSON.stringify` there, crashing the whole run with partial/empty stdout — a breach
// of the #943/#1000/#1063 contract that every `--json` exit path leaves stdout a single
// JSON.parse-able value. `safeStringifyJson` guards it: BigInt→string, circular→marker,
// and a valid-JSON `[]` fallback if even the guarded pass throws.
import { describe, expect, it, vi } from 'vite-plus/test';
import { safeStringifyJson } from '../src/commands/check.js';

describe('safeStringifyJson (#1060 — non-serializable --json values must not crash)', () => {
  it('coerces a BigInt to a string instead of throwing', () => {
    const out = safeStringifyJson([{ stack: 's', drifted: 1, value: 10n }]);
    const parsed = JSON.parse(out); // must not throw, must be valid JSON
    expect(parsed).toEqual([{ stack: 's', drifted: 1, value: '10' }]);
  });

  it('replaces a circular reference with a marker instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node; // circular
    const out = safeStringifyJson([node]);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([{ name: 'a', self: '[Circular]' }]);
  });

  it('handles a BigInt nested inside a circular structure', () => {
    const a: Record<string, unknown> = { size: 5n };
    const b: Record<string, unknown> = { a };
    a.b = b; // circular via b -> a -> b
    const out = safeStringifyJson({ a, b });
    const parsed = JSON.parse(out);
    // both the BigInt coercion and the cycle break survive; only that it parsed + coerced
    expect(JSON.stringify(parsed)).toContain('"size":"5"');
    expect(JSON.stringify(parsed)).toContain('[Circular]');
  });

  it('emits valid-JSON "[]" fallback (not a throw) when even the guarded pass fails, logging to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // a throwing toJSON defeats the replacer (JSON.stringify calls toJSON before the replacer)
      const hostile = {
        toJSON() {
          throw new Error('boom');
        },
      };
      const out = safeStringifyJson([hostile]);
      expect(out).toBe('[]');
      expect(JSON.parse(out)).toEqual([]); // still a single JSON.parse-able value
      expect(err).toHaveBeenCalled(); // diagnostic went to stderr, never stdout
    } finally {
      err.mockRestore();
    }
  });

  it('passes an ordinary serializable value through unchanged', () => {
    const reports = [{ stack: 's (us-east-1)', drifted: 0, findings: [], error: 'skipped' }];
    expect(JSON.parse(safeStringifyJson(reports))).toEqual(reports);
  });
});

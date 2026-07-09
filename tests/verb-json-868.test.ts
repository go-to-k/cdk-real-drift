import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { emitJsonArray, stackLabel } from '../src/commands/verb-json.js';

// #868: record / ignore / revert now honor --json — one top-level JSON array, one element
// per stack, symmetric with check. These tests pin the helpers + the top-level-error
// contract ([] on stdout, never empty bytes). The per-stack element shape on a real
// gather is exercised by the live-test (a deployed fixture).

describe('verb-json helpers (#868)', () => {
  it('stackLabel formats "<stack> (<region>)", or bare stack without a region', () => {
    expect(stackLabel('A', 'us-east-1')).toBe('A (us-east-1)');
    expect(stackLabel('A', undefined)).toBe('A');
  });

  it('emitJsonArray prints one JSON.parse-able array to stdout', () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    emitJsonArray([{ stack: 'A', recorded: 2 }]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([{ stack: 'A', recorded: 2 }]);
    log.mockRestore();
  });
});

// Drive each verb with synth mocked so resolveStacks throws → the top-level error path
// must still leave stdout a valid empty array under --json (never empty bytes).
vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: () => Promise.reject(new Error('boom: un-synthesizable app')),
}));

import { runIgnore } from '../src/commands/ignore.js';
import { runRecord } from '../src/commands/record.js';
import { runRevert } from '../src/commands/revert.js';

describe('record/ignore/revert --json emit [] on a top-level error (#868)', () => {
  afterEach(() => vi.restoreAllMocks());

  const runners: [string, (args: string[]) => Promise<number>][] = [
    ['record', runRecord],
    ['ignore', runIgnore],
    ['revert', runRevert],
  ];

  for (const [name, run] of runners) {
    it(`${name} --json prints "[]" and exits 2 when synth throws`, async () => {
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
        out.push(String(m));
      });
      vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
        err.push(String(m));
      });

      const code = await run(['--json', '--yes']);

      expect(code).toBe(2);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toEqual([]); // parseable, never ''
      expect(err.join('\n')).toContain('boom'); // the error still surfaces on stderr
    });

    it(`${name} (text mode) writes nothing to stdout on a top-level error`, async () => {
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
        out.push(String(m));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const code = await run([]);
      expect(code).toBe(2);
      expect(out).toEqual([]);
    });
  }
});

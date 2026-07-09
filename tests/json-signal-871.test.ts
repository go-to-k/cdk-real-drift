import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { deletedStackReport } from '../src/report/report.js';

// #871 part 1 — a DELETED stack is the strongest drift, so its --json element must be
// drifted:1 + stackDeleted:true, NOT the drifted:0 + `error` shape (`error` is reserved
// for a stack that failed BEFORE it could be checked). A consumer summing `drifted`
// across stacks would otherwise see ZERO on an exit-1 run where a whole stack is gone.
describe('deletedStackReport (#871)', () => {
  it('signals drifted:1 + stackDeleted:true, no error field', () => {
    const r = deletedStackReport('MyStack (us-east-1)');
    expect(r).toEqual({
      stack: 'MyStack (us-east-1)',
      drifted: 1,
      findings: [],
      stackDeleted: true,
    });
    expect(r.error).toBeUndefined(); // never the pre-check-error shape
    expect(r.drifted).toBe(1); // a consumer summing `drifted` sees the deletion
  });
});

// #871 part 2 — a whole-run failure BEFORE any stack is known still leaves --json stdout
// a single JSON.parse-able value ([]), not empty. Mock synth so resolveStacks throws.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: () => Promise.reject(new Error('boom: app could not be synthesized')),
}));

import { runCheck } from '../src/commands/check.js';

describe('check --json emits [] (not empty stdout) on a top-level error (#871)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--json prints "[]" to stdout and exits 2 when resolveStacks throws', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });

    const code = await runCheck(['--json']);

    expect(code).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([]); // parseable, never ''
    expect(err.join('\n')).toContain('boom'); // the error still surfaces on stderr
  });

  it('text mode writes the error only to stderr, nothing to stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });

    const code = await runCheck([]);

    expect(code).toBe(2);
    expect(out).toEqual([]); // no stray stdout in text mode
    expect(err.join('\n')).toContain('boom');
  });
});

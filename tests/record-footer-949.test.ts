import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #949: in a MULTI-STACK `record` run with a PARTIAL failure — one stack writes a baseline
// (wroteAny === true) but a SIBLING stack errors (worst === 2) — the "commit the baseline
// file(s) …" footer was suppressed, because it was gated on `worst === 0`. The user was
// never told to commit the file that WAS written (a real usability bug — they may forget
// it). The footer must now fire on `wroteAny` alone; the exit code (worst) is unchanged.
//
// Same mocking shape as record-footer-799.test.ts, but resolveStacks yields TWO stacks so
// one can write while the other throws.

vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () =>
    Promise.resolve([
      { stackName: 'Dev', region: 'us-east-1', template: {} },
      { stackName: 'Prod', region: 'us-east-1', template: {} },
    ]),
}));

vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: () => Promise.resolve({ desired: { accountId: '111111111111' }, findings: [] }),
}));

vi.mock('../src/commands/progress.js', () => ({
  gatherWithProgress: (_show: boolean, _label: string, fn: () => unknown) => fn(),
  progressLabel: () => '',
}));

vi.mock('../src/config/config-file.js', () => ({
  loadConfig: () => Promise.resolve({}),
  applyIgnores: (findings: unknown) => findings,
}));

vi.mock('../src/cli-args.js', () => ({
  parseCommonArgs: () => ({ profile: undefined, json: false, yes: true, verbose: false }),
  isInteractive: () => false,
}));

const recordStack = vi.fn();
vi.mock('../src/commands/stack-actions.js', () => ({
  recordStack: (...a: unknown[]) => recordStack(...a),
  warnStackStatus: () => {}, // #786: record.ts imports this; no-op in these footer tests
}));

import { runRecord } from '../src/commands/record.js';

const FOOTER = 'commit the baseline file(s) so drift is detected against them going forward.';

describe('runRecord — commit-nudge footer under a partial multi-stack failure (#949)', () => {
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    recordStack.mockReset();
    logs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (s: unknown) => logs.push(String(s));
    console.error = () => {}; // silence the per-stack error line
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  it('PRINTS the footer when one stack wrote even though a sibling stack errored', async () => {
    // Dev writes a baseline; Prod throws (a generic error → worst 2).
    recordStack
      .mockResolvedValueOnce({ wrote: true, refused: false })
      .mockRejectedValueOnce(new Error('boom'));
    const rc = await runRecord([]);
    expect(rc).toBe(2); // exit code still reflects the sibling failure
    expect(logs).toContain(FOOTER); // …but the written baseline must still be nudged to commit
  });

  it('SUPPRESSES the footer when every stack was cancelled (nothing written)', async () => {
    // wroteAny stays false → no nudge, even though the run is otherwise clean.
    recordStack.mockResolvedValue({ wrote: false, refused: false });
    const rc = await runRecord([]);
    expect(rc).toBe(0);
    expect(logs).not.toContain(FOOTER);
  });
});

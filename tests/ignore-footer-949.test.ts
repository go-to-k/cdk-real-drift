import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #949: in a MULTI-STACK `ignore` run with a PARTIAL failure — one stack writes a rule to
// .cdkrd/ignore.yaml (wroteAny === true) but a SIBLING stack errors (worst === 2) — the
// "commit .cdkrd/ignore.yaml …" footer was suppressed, because it was gated on
// `worst === 0`. The user was never told to commit the file that WAS written. The footer
// must now fire on `wroteAny` alone; the exit code (worst) is unchanged.
//
// resolveStacks yields TWO stacks so one can write while the other throws.

vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () =>
    Promise.resolve([
      { stackName: 'Dev', region: 'us-east-1', template: {} },
      { stackName: 'Prod', region: 'us-east-1', template: {} },
    ]),
}));

vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: () =>
    Promise.resolve({ desired: { accountId: '111111111111', resources: [] }, findings: [] }),
}));

vi.mock('../src/commands/progress.js', () => ({
  gatherWithProgress: (_show: boolean, _label: string, fn: () => unknown) => fn(),
  progressLabel: () => '',
}));

vi.mock('../src/config/config-file.js', () => ({
  loadConfig: () => Promise.resolve({}),
  applyIgnores: (findings: unknown) => findings,
}));

// baseline reconciliation is not under test here — stub it to a clean pass-through.
vi.mock('../src/baseline/baseline-file.js', () => ({
  loadBaseline: () => Promise.resolve(null),
  checkBaselineAccount: () => {},
  applyBaseline: (findings: unknown) => findings,
  declaredKeysByLogical: () => ({}),
  // #1285: ignore.ts's ignoreApplyBaselineOpts now also calls this — stub it so the
  // opts builder does not throw on an undefined import under this module mock.
  constructPathsByLogical: () => new Map(),
  physicalIdsByLogical: () => ({}),
}));

vi.mock('../src/cli-args.js', () => ({
  parseCommonArgs: () => ({ profile: undefined, json: false, yes: true, verbose: false }),
  isInteractive: () => false,
}));

const ignoreStack = vi.fn();
vi.mock('../src/commands/stack-actions.js', () => ({
  ignoreStack: (...a: unknown[]) => ignoreStack(...a),
  warnStackStatus: () => {}, // #786: ignore.ts imports this; no-op in these footer tests
}));

import { runIgnore } from '../src/commands/ignore.js';

const FOOTER = 'commit .cdkrd/ignore.yaml so the ignore rules apply for everyone going forward.';

describe('runIgnore — commit-nudge footer under a partial multi-stack failure (#949)', () => {
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    ignoreStack.mockReset();
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
    // Dev writes a rule; Prod throws (a generic error → worst 2).
    ignoreStack
      .mockResolvedValueOnce({ wrote: true, refused: false, added: 1 })
      .mockRejectedValueOnce(new Error('boom'));
    const rc = await runIgnore([]);
    expect(rc).toBe(2); // exit code still reflects the sibling failure
    expect(logs).toContain(FOOTER); // …but the written ignore.yaml must still be nudged to commit
  });

  it('SUPPRESSES the footer when every stack was cancelled (nothing written)', async () => {
    // wroteAny stays false → no nudge, even though the run is otherwise clean.
    ignoreStack.mockResolvedValue({ wrote: false, refused: false, added: 0 });
    const rc = await runIgnore([]);
    expect(rc).toBe(0);
    expect(logs).not.toContain(FOOTER);
  });
});

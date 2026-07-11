import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #1336: the per-stack --json element key `baseline` meant two different things across
// verbs — check's BOOLEAN presence flag (#1095) vs record's baseline-file PATH string
// (#983). A consumer keying `element.baseline` uniformly across a check-then-record
// pipeline silently misreads one of them. record's field is renamed `baselinePath`
// (self-describing, parallel to ignore's `config` path field) BEFORE the --json shape
// becomes a published API; the `baseline` key now belongs to check alone.
//
// Same mocking shape as record-footer-799/949.test.ts, but with --json on so runRecord
// emits the JSON array instead of the text report.

vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () => Promise.resolve([{ stackName: 'Dev', region: 'us-east-1', template: {} }]),
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
  parseCommonArgs: () => ({ profile: undefined, json: true, yes: true, verbose: false }),
  isInteractive: () => false,
}));

const recordStack = vi.fn();
vi.mock('../src/commands/stack-actions.js', () => ({
  recordStack: (...a: unknown[]) => recordStack(...a),
  warnStackStatus: () => {},
}));

import { runRecord } from '../src/commands/record.js';

const PATH = '.cdkrd/baselines/Dev.111111111111.us-east-1.json';

describe('record --json element carries baselinePath, never a `baseline` key (#1336)', () => {
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    recordStack.mockReset();
    logs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (s: unknown) => logs.push(String(s));
    console.error = () => {};
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  function parsedElement(): Record<string, unknown> {
    expect(logs).toHaveLength(1); // one top-level JSON array (#868)
    const arr = JSON.parse(logs[0]!) as Record<string, unknown>[];
    expect(arr).toHaveLength(1);
    return arr[0]!;
  }

  it('a written baseline emits `baselinePath` (the path string) and no `baseline` key', async () => {
    recordStack.mockResolvedValue({ wrote: true, refused: false, count: 2, path: PATH });
    const rc = await runRecord([]);
    expect(rc).toBe(0);

    const el = parsedElement();
    expect(el.baselinePath).toBe(PATH);
    // The `baseline` key is check's BOOLEAN flag (#1095) — record must never emit it,
    // in either the old string form or any other shape.
    expect('baseline' in el).toBe(false);
    expect(el).toMatchObject({ recorded: 2, wrote: true });
  });

  it('no baseline written → both keys absent (baselinePath stays optional)', async () => {
    recordStack.mockResolvedValue({ wrote: false, refused: false, count: 0 });
    const rc = await runRecord([]);
    expect(rc).toBe(0);

    const el = parsedElement();
    expect('baselinePath' in el).toBe(false);
    expect('baseline' in el).toBe(false);
  });
});

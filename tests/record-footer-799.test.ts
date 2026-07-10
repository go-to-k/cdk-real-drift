import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #799: standalone `cdkrd record`, cancelled at the multiselect (nothing written on
// ANY stack), still printed the success footer "commit the baseline file(s) …" —
// telling the user to commit files that were never written. The cancel paths in
// stack-actions.ts return `{ wrote:false, refused:false }`, a clean no-op that leaves
// `worst === 0`, so the old unconditional footer fired. runRecord must now gate the
// footer on at least one stack actually writing a baseline.
//
// Mock runRecord's heavy dependencies so the test drives only the write/footer logic:
//   - resolveStacks → a single fixed stack (no CDK synth / AWS)
//   - gatherWithProgress → a canned gather result (no AWS read)
//   - recordStack → the unit under test's input: we flip its `wrote` flag
//   - loadConfig/applyIgnores → trivial pass-throughs
//   - cli-args → non-interactive with no --profile (parseCommonArgs default shape)

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

// json:false — this suite tests the TEXT-mode "commit …" footer. Under --json (#868) the
// footer is intentionally suppressed (the JSON array is stdout), so text mode is the
// correct fixture for the footer-gating behavior.
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

describe('runRecord — "commit the baseline file(s)" footer is gated on a real write (#799)', () => {
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    recordStack.mockReset();
    logs = [];
    origLog = console.log;
    console.log = (s: unknown) => logs.push(String(s));
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('SUPPRESSES the footer when the record was cancelled (nothing written)', async () => {
    // The cancel path: a clean no-op — no write, no refusal.
    recordStack.mockResolvedValue({ wrote: false, refused: false });
    const rc = await runRecord([]);
    expect(rc).toBe(0); // still a clean exit — cancelling is not an error
    expect(logs).not.toContain(FOOTER);
  });

  it('PRINTS the footer when a stack actually wrote a baseline', async () => {
    recordStack.mockResolvedValue({ wrote: true, refused: false });
    const rc = await runRecord([]);
    expect(rc).toBe(0);
    expect(logs).toContain(FOOTER);
  });
});

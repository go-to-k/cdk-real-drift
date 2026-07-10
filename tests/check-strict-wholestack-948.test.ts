import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { StackNotCheckableError } from '../src/aws-errors.js';

// #948 — a whole stack dropped from the multi-stack loop (skipped, not checked) is the
// MAXIMAL coverage gap, so under --strict it must exit 1 — the same contract a single
// skipped RESOURCE and the deleted-stack path (#781) already honor. Two `continue` paths
// used to drop the stack WITHOUT folding into `worst`, so `--strict` silently exited 0.
//
// runCheck resolves a CDK app (resolveApp) and discovers its stacks (discoverStacks),
// then gathers findings per stack (gatherFindings) and — under --pre-deploy — synthesizes
// the local app (synthApp) to build the declared-source templates. Mock exactly those.

vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

const discoverStacksMock = vi.fn();
const synthAppMock = vi.fn();
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: (...args: unknown[]) => discoverStacksMock(...args),
  synthApp: (...args: unknown[]) => synthAppMock(...args),
}));

const gatherFindingsMock = vi.fn();
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: (...args: unknown[]) => gatherFindingsMock(...args),
}));

import { runCheck } from '../src/commands/check.js';

// A single discovered stack, region-pinned so no profile-region lookup is needed.
const oneStack = (stackName: string, region = 'us-east-1') => [
  { stackName, region, template: {} as Record<string, unknown> },
];

describe('#948 StackNotCheckableError whole-stack skip contributes to --strict exit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    discoverStacksMock.mockReset();
    synthAppMock.mockReset();
    gatherFindingsMock.mockReset();
  });

  it('--strict --fail exits 1 when a stack is DELETE_IN_PROGRESS (skipped, unchecked)', async () => {
    discoverStacksMock.mockResolvedValue(oneStack('Prod'));
    gatherFindingsMock.mockRejectedValue(
      new StackNotCheckableError('stack is in DELETE_IN_PROGRESS')
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCheck(['--strict', '--fail'])).toBe(1);
  });

  it('without --strict the same skip still exits 0 (report-only skip preserved)', async () => {
    discoverStacksMock.mockResolvedValue(oneStack('Prod'));
    gatherFindingsMock.mockRejectedValue(
      new StackNotCheckableError('stack is in REVIEW_IN_PROGRESS')
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // --fail alone (no --strict) must NOT fail: a skipped stack is not drift.
    expect(await runCheck(['--fail'])).toBe(0);
  });
});

describe('#948 --pre-deploy named stack missing from synth output contributes to --strict', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    discoverStacksMock.mockReset();
    synthAppMock.mockReset();
    gatherFindingsMock.mockReset();
  });

  it('--strict --fail exits 1 when a user-named stack is absent from the second synth', async () => {
    // Discovery finds Prod, but the --pre-deploy synth produces only SomethingElse, so
    // Prod's synth key is missing → the "not in the synth output — skipped" branch.
    discoverStacksMock.mockResolvedValue(oneStack('Prod'));
    synthAppMock.mockResolvedValue([
      { stackName: 'SomethingElse', region: 'us-east-1', template: {} },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCheck(['Prod', '--pre-deploy', '--fail', '--strict'])).toBe(1);
    // gatherFindings must NEVER run — the stack was dropped before the gather phase.
    expect(gatherFindingsMock).not.toHaveBeenCalled();
  });

  it('without --strict the same pre-deploy skip still exits 0', async () => {
    discoverStacksMock.mockResolvedValue(oneStack('Prod'));
    synthAppMock.mockResolvedValue([
      { stackName: 'SomethingElse', region: 'us-east-1', template: {} },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCheck(['Prod', '--pre-deploy', '--fail'])).toBe(0);
    expect(gatherFindingsMock).not.toHaveBeenCalled();
  });
});

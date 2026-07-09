// #948 — a WHOLE-stack skip must contribute to `--strict`'s coverage-gap exit exactly
// as one skipped RESOURCE does (strictCoverageExit). Two per-stack `continue` paths
// dropped the stack from the run without bumping `worst`, so a CI run that examined
// NOTHING for that stack exited 0:
//   1. StackNotCheckableError (REVIEW_IN_PROGRESS / *_IN_PROGRESS / ROLLBACK_COMPLETE).
//   2. A NAMED stack the --pre-deploy synth did not produce.
// Both must exit 1 under --strict (the coverage axis, independent of --fail's drift
// axis), and stay 0 when --strict is absent (a benign skip is not drift).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { StackNotCheckableError } from '../src/aws-errors.js';

const resolveStacksMock = vi.fn();
const gatherFindingsMock = vi.fn();
const synthAppMock = vi.fn();

vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: (...args: unknown[]) => resolveStacksMock(...args),
}));
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: (...args: unknown[]) => gatherFindingsMock(...args),
}));
vi.mock('../src/synth/synth.js', () => ({
  synthApp: (...args: unknown[]) => synthAppMock(...args),
}));
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

import { runCheck } from '../src/commands/check.js';

describe('check --strict on a whole-stack skip (#948)', () => {
  beforeEach(() => {
    resolveStacksMock.mockReset();
    gatherFindingsMock.mockReset();
    synthAppMock.mockReset();
    // keep test output clean
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('1) StackNotCheckableError exits 1 under --strict', async () => {
    resolveStacksMock.mockResolvedValue([{ stackName: 'Prod', region: 'us-east-1', template: {} }]);
    gatherFindingsMock.mockRejectedValue(
      new StackNotCheckableError('is being deleted (DELETE_IN_PROGRESS)')
    );
    expect(await runCheck(['--strict', '--fail'])).toBe(1);
  });

  it('1b) the same skip stays 0 without --strict (a benign skip is not drift)', async () => {
    resolveStacksMock.mockResolvedValue([{ stackName: 'Prod', region: 'us-east-1', template: {} }]);
    gatherFindingsMock.mockRejectedValue(
      new StackNotCheckableError('is being deleted (DELETE_IN_PROGRESS)')
    );
    expect(await runCheck(['--fail'])).toBe(0);
  });

  it('2) a NAMED stack missing from the --pre-deploy synth exits 1 under --strict', async () => {
    resolveStacksMock.mockResolvedValue([{ stackName: 'Prod', region: 'us-east-1', template: {} }]);
    // the second synth produced a DIFFERENT stack — 'Prod' is absent from synthTemplates
    synthAppMock.mockResolvedValue([
      { stackName: 'SomethingElse', region: 'us-east-1', template: {} },
    ]);
    expect(await runCheck(['Prod', '--pre-deploy', '--fail', '--strict'])).toBe(1);
  });

  it('2b) the same missing named stack stays 0 without --strict', async () => {
    resolveStacksMock.mockResolvedValue([{ stackName: 'Prod', region: 'us-east-1', template: {} }]);
    synthAppMock.mockResolvedValue([
      { stackName: 'SomethingElse', region: 'us-east-1', template: {} },
    ]);
    expect(await runCheck(['Prod', '--pre-deploy', '--fail'])).toBe(0);
  });
});

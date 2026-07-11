// #1325: `check --pre-deploy` runs a SECOND synth (the local template becomes the DECLARED
// source). #905 scoped the DISCOVERY synth's toolkit-lib metadata validation to the target
// stacks (via `stackPatterns` → a StackSelector) so a failing context lookup in an UNRELATED
// sibling stack cannot abort a named-stack check. But that pre-deploy second synth passed NO
// `stackPatterns`, so it re-validated EVERY stack — re-opening the exact #905 abort for the
// --pre-deploy path (#957 fixed only its region parity, not its selector parity). This drives
// runCheck end to end (synth/read mocked) and asserts the opts the pre-deploy `synthApp`
// receives carry the same target scope the discovery synth uses.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Finding } from '../src/types.js';

const REGION = 'us-east-1';
const STACK = 'GoodStack';

// resolveStacks yields one target stack; the pre-deploy synth yields the SAME stack (so it is
// not "not in the synth output" skipped). The synthApp mock records the opts it was called
// with. Referenced lazily through an arrow because the vi.mock factory is hoisted above the
// mock's definition (the #905 test's pattern).
interface SynthOpts {
  region?: string | undefined;
  profile?: string | undefined;
  context?: Record<string, string> | undefined;
  stackPatterns?: string[] | undefined;
  preDeploy?: boolean | undefined;
}
type SynthAppFn = (
  app: string,
  opts?: SynthOpts
) => Promise<Array<{ stackName: string; region: string; template: Record<string, unknown> }>>;
const synthAppMock = vi.fn<SynthAppFn>((_app, _opts) =>
  Promise.resolve([{ stackName: STACK, region: REGION, template: {} }])
);
vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () => Promise.resolve([{ stackName: STACK, region: REGION, template: {} }]),
}));
vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
vi.mock('../src/synth/synth.js', () => ({
  synthApp: (app: string, opts?: SynthOpts) => synthAppMock(app, opts),
  discoverStacks: () => Promise.resolve([{ stackName: STACK, region: REGION, template: {} }]),
}));

vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: () =>
    Promise.resolve({
      desired: {
        stackName: STACK,
        region: REGION,
        accountId: '111122223333',
        resources: [],
        rawTemplate: '{}',
        ctx: {},
      },
      findings: [] as Finding[],
      schemas: new Map(),
      liveByLogical: new Map(),
    }),
}));

import { runCheck } from '../src/commands/check.js';

function lastSynthOpts(): SynthOpts {
  return synthAppMock.mock.calls.at(-1)?.[1] ?? {};
}

describe('#1325 --pre-deploy synth inherits the #905 target scope', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    synthAppMock.mockClear();
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-predeploy-selector-1325-'));
    process.chdir(dir); // isolate config (no .cdkrd/ignore.yaml) + baseline lookups
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a named target scopes the pre-deploy synth to THAT stack (sibling not re-validated)', async () => {
    await runCheck([STACK, '--pre-deploy', '--region', REGION]);
    expect(synthAppMock).toHaveBeenCalledTimes(1);
    const opts = lastSynthOpts();
    expect(opts.preDeploy).toBe(true);
    // The fix: the same scope the discovery synth got. Without it this was `undefined`, so a
    // sibling stack's failing lookup aborted the whole --pre-deploy run (exit 2, nothing checked).
    expect(opts.stackPatterns).toEqual([STACK]);
  });

  it('a glob target forwards the glob pattern', async () => {
    await runCheck(['Good*', '--pre-deploy', '--region', REGION]);
    expect(lastSynthOpts().stackPatterns).toEqual(['Good*']);
  });

  it('no-args (whole app) forwards NO scope — validate every stack, unchanged behavior', async () => {
    await runCheck(['--pre-deploy', '--region', REGION]);
    expect(lastSynthOpts().stackPatterns).toBeUndefined();
  });

  it('--all forwards NO scope even with a positional name (target everything)', async () => {
    await runCheck([STACK, '--all', '--pre-deploy', '--region', REGION]);
    expect(lastSynthOpts().stackPatterns).toBeUndefined();
  });
});

// #883 (Part 1 wiring) — the report renderer groups a not-yet-deployed (no-physical-id)
// skip as its own "pending creation" footer line INSTEAD of "coverage incomplete", but
// only when it receives `preDeploy: true` (report.ts gates the split on opts.preDeploy).
// check.ts's --pre-deploy text-report call must pass that flag, or the renderer's
// pending-creation branch is dead code and the footer contradicts the #727 stderr note
// (which already says the count is "not a coverage gap"). This drives runCheck end to end
// (synth/read mocked) under --pre-deploy and asserts the footer says "pending creation",
// not "coverage incomplete".
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Finding } from '../src/types.js';

const REGION = 'us-east-1';
const STACK = 'PreStack';

// resolveStacks yields one target stack; the --pre-deploy synth yields the SAME stack
// (so it is not "not in the synth output" skipped), and gatherFindings returns a single
// not-yet-deployed resource (the "no physical id" skip #727/gather emits) plus a minimal
// desired so the pre-deploy report path is reached.
vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () => Promise.resolve([{ stackName: STACK, region: REGION, template: {} }]),
}));
vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
vi.mock('../src/synth/synth.js', () => ({
  synthApp: () => Promise.resolve([{ stackName: STACK, region: REGION, template: {} }]),
  discoverStacks: () => Promise.resolve([{ stackName: STACK, region: REGION, template: {} }]),
}));

const pendingSkip: Finding = {
  tier: 'skipped',
  logicalId: 'Q',
  resourceType: 'AWS::SQS::Queue',
  path: '',
  note: 'no physical id',
};

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
      findings: [pendingSkip],
      schemas: new Map(),
      liveByLogical: new Map(),
    }),
}));

import { runCheck } from '../src/commands/check.js';

describe('#883 --pre-deploy footer groups a not-yet-deployed skip as "pending creation"', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-predeploy-footer-883-'));
    process.chdir(dir); // isolate config (no .cdkrd/ignore.yaml) + baseline lookups
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('renders "pending creation", NOT "coverage incomplete", for the no-physical-id skip', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCheck([STACK, '--pre-deploy']);

    const text = out.join('\n');
    expect(text).toContain('pending creation');
    // The pre-fix behavior branded the same skip "coverage incomplete" — the wire's whole point.
    expect(text).not.toContain('coverage incomplete');
  });
});

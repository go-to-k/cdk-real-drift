// #1335 — sibling of #1095. `--pre-deploy` and `--show-all` never CONSULT the baseline
// (both are baseline-untouched modes: --pre-deploy compares against the local synth
// template, --show-all inventories all current undeclared state), yet their --json
// elements emitted `"baseline": false` — the #1095 contract's "never recorded" claim —
// even when a committed baseline exists. Mechanism: the --pre-deploy branch called
// buildStackJson() with no hasBaseline arg and --show-all passed `baseline !== undefined`
// on a deliberately-unloaded (undefined) baseline; both coerced to present-and-false.
// The fix OMITS the flag when the baseline was not consulted (absent = "not consulted",
// false = "consulted, never recorded"), matching the documented omitted-on-error rule.
// This drives runCheck end to end (synth/read mocked) and asserts the key is ABSENT in
// both modes — with AND without a baseline on disk — while plain check keeps true/false.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { baselinePath } from '../src/baseline/baseline-file.js';
import type { StackJsonReport } from '../src/report/report.js';

const STACK = 'MyStack';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

// One resolved stack, no synth needed for the stack list. gatherFindings returns a CLEAN
// gather (no findings) whose desired accountId matches any on-disk baseline's account (so
// the per-account guard is silent). A quiet stack is exactly where a spurious
// `baseline: false` would misread as "unwatched" despite a committed baseline.
vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () =>
    Promise.resolve([{ stackName: 'MyStack', region: 'us-east-1', template: {} }]),
}));
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: () =>
    Promise.resolve({
      desired: {
        stackName: 'MyStack',
        region: 'us-east-1',
        accountId: '111122223333',
        resources: [],
        rawTemplate: '{}',
        ctx: {},
      },
      findings: [],
      schemas: new Map(),
      liveByLogical: new Map(),
    }),
}));
// --pre-deploy synthesizes the local app up front for its declared source: stub the app
// resolution + synth so the branch runs without a real CDK app.
vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
vi.mock('../src/synth/synth.js', () => ({
  synthApp: () => Promise.resolve([{ stackName: 'MyStack', region: 'us-east-1', template: {} }]),
  discoverStacks: () => Promise.resolve([]),
}));

import { runCheck } from '../src/commands/check.js';

// A v2 (snapshot-tracking) baseline so the schema-v1 warning does not fire.
async function writeBaseline(): Promise<void> {
  const p = baselinePath(STACK, ACCOUNT, REGION);
  await mkdir(dirname(p), { recursive: true });
  const file = {
    schemaVersion: 2,
    stackName: STACK,
    region: REGION,
    accountId: ACCOUNT,
    capturedAt: '',
    templateHash: '', // empty → warnTemplateHashDrift is a no-op
    recorded: [],
    completeResources: [],
  };
  await writeFile(p, JSON.stringify(file), 'utf8');
}

describe('#1335 baseline-not-consulted modes OMIT the --json baseline flag', () => {
  let cwd: string;
  let dir: string;
  let out: string[];
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-json-baseline-1335-'));
    process.chdir(dir);
    out = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function parsed(): StackJsonReport[] {
    expect(out).toHaveLength(1);
    const value = JSON.parse(out[0]!);
    expect(Array.isArray(value)).toBe(true);
    return value as StackJsonReport[];
  }

  it('--pre-deploy --json, WITH a committed baseline: the baseline key is ABSENT (not false)', async () => {
    await writeBaseline();
    const code = await runCheck(['--pre-deploy', '--json', STACK]);

    const el = parsed()[0]!;
    // The bug: this element carried `baseline: false` — "never recorded" — while the
    // committed baseline sat right there on disk. Not consulted → omitted.
    expect('baseline' in el).toBe(false);
    expect(el.drifted).toBe(0);
    expect(code).toBe(0);
  });

  it('--pre-deploy --json, NO baseline: the key is still ABSENT (never a false-asserting flag)', async () => {
    const code = await runCheck(['--pre-deploy', '--json', STACK]);

    const el = parsed()[0]!;
    expect('baseline' in el).toBe(false);
    expect(code).toBe(0);
  });

  it('--show-all --json, WITH a committed baseline: the baseline key is ABSENT (not false)', async () => {
    await writeBaseline();
    const code = await runCheck(['--show-all', '--json', STACK]);

    const el = parsed()[0]!;
    // --show-all deliberately loads baseline=undefined (inventory mode); the old
    // `baseline !== undefined` threading turned that into a false "never recorded".
    expect('baseline' in el).toBe(false);
    expect(el.drifted).toBe(0);
    expect(code).toBe(0);
  });

  it('plain check --json still emits baseline: true / false (#1095 contract unchanged)', async () => {
    const code = await runCheck(['--json', STACK]);
    expect(parsed()[0]!.baseline).toBe(false); // consulted, none exists

    out.length = 0;
    await writeBaseline();
    const code2 = await runCheck(['--json', STACK]);
    expect(parsed()[0]!.baseline).toBe(true); // consulted, watched

    expect(code).toBe(0);
    expect(code2).toBe(0);
  });
});

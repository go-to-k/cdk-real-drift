// #1095 — sibling of #944. A missing baseline SHIFTS the classification semantics: the
// undeclared dimension is not watched, so appeared-since-record out-of-band values read
// as `unrecorded` and are excluded from `drifted`. Under `--json` a QUIET stack with NO
// baseline therefore emitted `{ stack, drifted: 0, findings: [] }` — byte-identical to a
// baselined, fully-watched clean stack. A CI consumer summing `drifted` could not tell an
// UNWATCHED stack from a watched clean one. The fix does two things, both mirroring #944:
//  (a) the R142 "no baseline yet" note drops its `!a.json` gate and is emitted
//      UNCONDITIONALLY to stderr (the old gate dropped it NOWHERE under --json), and
//  (b) the --json element gains a `baseline` presence flag (false = never recorded).
// This drives runCheck end to end (synth/read mocked) with and without a baseline on disk
// and asserts the flag AND the stderr note.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { baselinePath } from '../src/baseline/baseline-file.js';
import type { StackJsonReport } from '../src/report/report.js';

const STACK = 'MyStack';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

// One resolved stack, no synth needed. gatherFindings returns a CLEAN gather (no findings)
// whose desired accountId matches any on-disk baseline's account (so the per-account guard
// is silent). This is the QUIET no-drift case — exactly where a no-baseline stack is
// otherwise indistinguishable from a watched clean one.
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

import { runCheck } from '../src/commands/check.js';

// A v2 (snapshot-tracking) baseline so the schema-v1 warning does NOT fire (isolating the
// baseline-presence signal from #944's).
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

const NO_BASELINE_NOTE = 'no .cdkrd baseline yet';

describe('#1095 --json carries a baseline-presence flag + the no-baseline note survives --json', () => {
  let cwd: string;
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-json-baseline-1095-'));
    process.chdir(dir);
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function parsed(): StackJsonReport[] {
    // stdout stays a single JSON.parse-able array (no note ever leaked onto it).
    expect(out).toHaveLength(1);
    const value = JSON.parse(out[0]!);
    expect(Array.isArray(value)).toBe(true);
    return value as StackJsonReport[];
  }

  it('--json, NO baseline: element carries baseline=false AND the note lands on STDERR', async () => {
    // No baseline written to disk.
    const code = await runCheck(['--json', STACK]);

    const el = parsed()[0]!;
    // (a) the new distinguisher: an unwatched (never-recorded) stack is baseline=false.
    expect(el.baseline).toBe(false);
    expect(el.drifted).toBe(0); // quiet + unwatched still reports drifted 0 …
    // (b) … but the note now makes it discoverable — and it goes to STDERR, not stdout.
    expect(err.join('\n')).toContain(NO_BASELINE_NOTE);
    expect(out.join('\n')).not.toContain(NO_BASELINE_NOTE);
    expect(code).toBe(0);
  });

  it('--json, WITH baseline: element carries baseline=true AND no no-baseline note', async () => {
    await writeBaseline();
    const code = await runCheck(['--json', STACK]);

    const el = parsed()[0]!;
    // A watched clean stack: baseline=true — now distinguishable from the unwatched case
    // above even though both are drifted:0.
    expect(el.baseline).toBe(true);
    expect(el.drifted).toBe(0);
    // No day-1 note when a baseline already exists.
    expect(err.join('\n')).not.toContain(NO_BASELINE_NOTE);
    expect(code).toBe(0);
  });
});

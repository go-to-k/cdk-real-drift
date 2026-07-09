// #944 — sibling of #871/#921. `check`'s three baseline warnings all go to stderr,
// so they survive `--json` (whose machine output is stdout) without polluting it.
// #921 made checkBaselineAccount + warnTemplateHashDrift fire UNCONDITIONALLY, but
// warnBaselineSchemaV1 kept the old `if (!a.json)` gate — so under `--json` a
// schema-v1 baseline's warning was printed NOWHERE (not stdout, not stderr). That
// warning matters MOST under --json: a schema-v1 baseline (no `completeResources`)
// shifts the classification semantics (appeared-since-record values read as
// `unrecorded`, excluded from `drifted`), so the --json consumer is exactly who
// needs to know. The fix drops the gate; the sink is `console.error`, so JSON
// stdout stays pure. This drives runCheck end to end (synth/read mocked) with a
// real schema-v1 baseline on disk and asserts the warning lands on STDERR while
// stdout stays a single JSON.parse-able array.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { baselinePath } from '../src/baseline/baseline-file.js';

const STACK = 'MyStack';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

// One resolved stack, no synth needed. gatherFindings returns a CLEAN gather (no
// findings) whose desired accountId matches the on-disk baseline's account (so the
// per-account guard is silent) and whose rawTemplate is irrelevant to the hash warning
// (the baseline's templateHash is empty → warnTemplateHashDrift returns early).
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

async function writeBaseline(schemaVersion: 1 | 2): Promise<void> {
  const p = baselinePath(STACK, ACCOUNT, REGION);
  await mkdir(dirname(p), { recursive: true });
  const file: Record<string, unknown> = {
    schemaVersion,
    stackName: STACK,
    region: REGION,
    accountId: ACCOUNT,
    capturedAt: '',
    templateHash: '', // empty → warnTemplateHashDrift is a no-op, isolating the schema-v1 signal
    recorded: [],
  };
  // A v2 file records snapshot completeness; a v1 file has NO completeResources — that
  // absence is exactly what warnBaselineSchemaV1 keys on.
  if (schemaVersion === 2) file.completeResources = [];
  await writeFile(p, JSON.stringify(file), 'utf8');
}

describe('#944 schema-v1 baseline warning survives --json (goes to stderr, stdout stays JSON)', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-json-schema-v1-944-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('--json: schema-v1 warning on STDERR, stdout is a valid JSON array (regression gate)', async () => {
    await writeBaseline(1);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });

    const code = await runCheck(['--json', STACK]);

    // The whole point of #944: the warning is emitted, and to stderr.
    expect(err.join('\n')).toContain('predates snapshot tracking');
    // stdout stays a single JSON.parse-able array (the warning never leaked onto it).
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    // Clean stack: report-only exit 0.
    expect(code).toBe(0);
  });

  it('--json: a v2 baseline emits NO schema-v1 warning (no false positive)', async () => {
    await writeBaseline(2);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });

    await runCheck(['--json', STACK]);

    expect(err.join('\n')).not.toContain('predates snapshot tracking');
    expect(out).toHaveLength(1);
    expect(Array.isArray(JSON.parse(out[0]!))).toBe(true);
  });
});

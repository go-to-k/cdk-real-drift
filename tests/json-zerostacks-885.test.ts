import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// runCheck resolves a CDK app (resolveApp) and discovers its stacks
// (discoverStacks). Mock both so the app defines ZERO stacks: resolveApp is
// truthy, discoverStacks yields [] → resolveStacks returns [] → runCheck hits
// the zero-stack early return. loadConfig returns {ignore:[]} on a missing
// .cdkrd/ignore.yaml, so no config fixture is needed.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: () => Promise.resolve([]),
}));

import { runCheck } from '../src/commands/check.js';

describe('check --json on a zero-stack app emits a parseable empty array, not empty stdout (#885)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--json prints "[]" to stdout (so JSON.parse(stdout) succeeds) and exits 0', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runCheck(['--json']);

    expect(code).toBe(0);
    // exactly one stdout line, and it parses to an empty array — the contract
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([]);
    log.mockRestore();
  });

  it('text mode writes the human note to stderr and NOTHING to stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      stdout.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      stderr.push(String(m));
    });

    const code = await runCheck([]);

    expect(code).toBe(0);
    expect(stdout).toEqual([]); // stdout stays clean in text mode
    expect(stderr.join('\n')).toContain('defines no stacks');
  });
});

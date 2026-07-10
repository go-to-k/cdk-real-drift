import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// resolveStacks synthesizes a CDK app (resolveApp) and discovers its stacks
// (discoverStacks) — both heavy. Mock them: resolveApp returns a truthy app,
// discoverStacks returns a fixed set of discovered stacks so we can exercise the
// name/glob matching in isolation.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

const discovered = [{ stackName: 'Dev', region: 'us-east-1', template: {} }];
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: () => Promise.resolve(discovered),
}));

import type { CommonArgs } from '../src/cli-args.js';
import { resolveStacks } from '../src/commands/resolve-stacks.js';

// Minimal CommonArgs with only the fields resolveStacks reads; the rest are
// defaulted to keep the fixture focused on stack resolution.
function args(overrides: Partial<CommonArgs>): CommonArgs {
  return {
    stackNames: [],
    all: false,
    region: 'us-east-1',
    profile: undefined,
    app: undefined,
    context: {},
    json: false,
    showAll: false,
    yes: false,
    preDeploy: false,
    undeclaredOnly: false,
    declaredOnly: false,
    fail: false,
    strict: false,
    removeUnrecorded: false,
    force: false,
    verbose: false,
    waitMs: undefined,
    ...overrides,
  };
}

describe('resolveStacks — a glob positional that matches zero stacks is a hard error (#778)', () => {
  beforeEach(() => {
    // Some other stacks resolved fine — the aggregate result is NON-empty, which is
    // exactly the case the old backstop `if (out.length === 0)` misses.
  });

  it('throws naming the unmatched glob even when a sibling exact name resolves', async () => {
    // `check 'Pord-*' Dev` — the exact `Dev` resolves, so out.length > 0 and the
    // aggregate check passes; without the per-glob count the typo'd `Pord-*` glob is
    // silently ignored (exit 0). It must throw, naming the pattern.
    await expect(resolveStacks(args({ stackNames: ['Pord-*', 'Dev'] }))).rejects.toThrow(
      /glob "Pord-\*" matched no stacks/
    );
  });

  it('throws for a lone no-match glob', async () => {
    await expect(resolveStacks(args({ stackNames: ['Nope-*'] }))).rejects.toThrow(
      /glob "Nope-\*" matched no stacks/
    );
  });

  it('resolves a glob that DOES match plus an exact name (no false throw)', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev*'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev']);
  });

  it('does not throw when a glob matches an ALREADY-added exact-name stack (dedup)', async () => {
    // `Dev` is added by the exact name; `Dev*` then matches it again. `add` dedups so
    // no net addition happens, but the glob DID match — counting matchesGlob hits (not
    // add() calls) means it must NOT error.
    const out = await resolveStacks(args({ stackNames: ['Dev', 'Dev*'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev']);
  });

  it('still throws the exact-name message for an unknown exact name', async () => {
    await expect(resolveStacks(args({ stackNames: ['Missing'] }))).rejects.toThrow(
      /stack "Missing" is not defined by the CDK app/
    );
  });
});

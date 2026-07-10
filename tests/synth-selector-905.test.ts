import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildStackSelector } from '../src/synth/synth.js';

// #905: a failing context lookup in an UNRELATED sibling stack must not abort a check of an
// explicitly-named, lookup-free stack. The fix scopes toolkit.synth's metadata validation to
// the TARGET stacks via a StackSelector. Two units are covered here:
//   1. buildStackSelector — the pure mapping from requested patterns to the StackSelector.
//   2. resolveStacks — that it forwards the target patterns to discoverStacks (which threads
//      them into synth) for named/glob targets, and forwards NOTHING (validate all) for the
//      no-args / --all discovery modes.

describe('buildStackSelector (#905) — scope synth validation to target stacks', () => {
  it('returns undefined for no patterns (→ toolkit-lib defaults to ALL_STACKS: validate all)', () => {
    // The no-args discovery / --all case: the user asked for everything, so no scope.
    expect(buildStackSelector(undefined)).toBeUndefined();
    expect(buildStackSelector([])).toBeUndefined();
  });

  it('returns a PATTERN_MATCH selector carrying the requested names/globs', () => {
    const sel = buildStackSelector(['GoodStack']);
    expect(sel).toEqual({
      strategy: StackSelectionStrategy.PATTERN_MATCH,
      patterns: ['GoodStack'],
    });
  });

  it('uses PATTERN_MATCH (halts successfully on zero match), NOT a MUST_MATCH strategy', () => {
    // PATTERN_MUST_MATCH throws when patterns match no stack; a staged-stack pattern can
    // legitimately match nothing against the hierarchical id, so we must NOT throw here —
    // resolveStacks keeps the real typo/no-match errors against the full discovered list.
    const sel = buildStackSelector(['Stage-Nested', 'Some*']);
    expect(sel?.strategy).toBe(StackSelectionStrategy.PATTERN_MATCH);
    expect(sel?.strategy).not.toBe(StackSelectionStrategy.PATTERN_MUST_MATCH);
    expect(sel?.strategy).not.toBe(StackSelectionStrategy.ALL_STACKS);
    expect(sel?.patterns).toEqual(['Stage-Nested', 'Some*']);
  });

  it('carries multiple mixed exact + glob patterns verbatim', () => {
    const sel = buildStackSelector(['Prod', 'Dev-*']);
    expect(sel?.patterns).toEqual(['Prod', 'Dev-*']);
  });
});

// resolveStacks synthesizes + discovers via discoverStacks (heavy — mocked). We assert the
// SynthOptions it hands discoverStacks: `stackPatterns` scopes synth validation. resolveApp
// is mocked to a truthy app so we exercise resolution in isolation.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

const discovered = [
  { stackName: 'GoodStack', region: 'us-east-1', template: {} },
  { stackName: 'BadLookupStack', region: 'us-east-1', template: {} },
];
type DiscoverFn = (
  app: string,
  opts?: { stackPatterns?: string[] | undefined }
) => Promise<typeof discovered>;
const discoverStacksMock = vi.fn<DiscoverFn>(() => Promise.resolve(discovered));
vi.mock('../src/synth/synth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/synth/synth.js')>();
  // Reference the mock lazily (the vi.mock factory is hoisted above discoverStacksMock's
  // definition), so we forward through an arrow rather than aliasing it directly.
  const discoverStacks: DiscoverFn = (app, opts) => discoverStacksMock(app, opts);
  return { ...actual, discoverStacks };
});

import type { CommonArgs } from '../src/cli-args.js';
import { resolveStacks } from '../src/commands/resolve-stacks.js';

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

// The SynthOptions passed to discoverStacks by the most recent resolveStacks call.
function lastSynthOpts(): { stackPatterns?: string[] | undefined } {
  const call = discoverStacksMock.mock.calls.at(-1);
  return call?.[1] ?? {};
}

describe('resolveStacks — forwards target patterns to scope synth validation (#905)', () => {
  beforeEach(() => {
    discoverStacksMock.mockClear();
  });

  it('an exact-name target scopes synth to THAT stack (sibling not validated)', async () => {
    await resolveStacks(args({ stackNames: ['GoodStack'] }));
    // The unrelated BadLookupStack is excluded from the selector, so its failing lookup can
    // no longer abort the synth of GoodStack.
    expect(lastSynthOpts().stackPatterns).toEqual(['GoodStack']);
  });

  it('a glob target scopes synth to the glob pattern', async () => {
    await resolveStacks(args({ stackNames: ['Good*'] }));
    expect(lastSynthOpts().stackPatterns).toEqual(['Good*']);
  });

  it('mixed exact + glob targets forward all patterns', async () => {
    await resolveStacks(args({ stackNames: ['GoodStack', 'Other-*'] })).catch(() => {
      // `Other-*` matches no discovered stack → resolveStacks throws (#778). We only care
      // that the patterns were forwarded to the synth scope BEFORE that check.
    });
    expect(lastSynthOpts().stackPatterns).toEqual(['GoodStack', 'Other-*']);
  });

  it('no-args discovery forwards NO scope (validate every stack — unchanged behavior)', async () => {
    await resolveStacks(args({ stackNames: [] }));
    expect(lastSynthOpts().stackPatterns).toBeUndefined();
  });

  it('--all combined with positional names is now a hard error (#1327), not a silent override', async () => {
    // #1327: --all + named stacks used to SILENTLY discard the names and target everything —
    // dangerous for `revert Prod --all --yes`. It now throws before any synth/discovery, so
    // discoverStacks is never reached.
    await expect(resolveStacks(args({ all: true, stackNames: ['GoodStack'] }))).rejects.toThrow(
      /--all cannot be combined with named stacks/
    );
    expect(discoverStacksMock).not.toHaveBeenCalled();
  });

  it('still resolves only the named stack (discovery returns all; selector only narrows validation)', async () => {
    const out = await resolveStacks(args({ stackNames: ['GoodStack'] }));
    expect(out.map((s) => s.stackName)).toEqual(['GoodStack']);
  });
});

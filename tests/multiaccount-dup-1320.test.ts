import { describe, expect, it, vi } from 'vite-plus/test';

// resolveStacks synthesizes a CDK app (resolveApp) and discovers its stacks
// (discoverStacks) — both heavy. Mock them the same way the #884 multi-REGION
// test does: resolveApp returns a truthy app, discoverStacks returns a fixed set
// so exact-name / glob matching can be exercised in isolation. Here the app
// defines the SAME stackName in the SAME region for TWO different ACCOUNTS — the
// #740 multi-account staple (a fixed stackName, env.account varying per stage).
// #884 added the region dedup axis but NOT the account axis, so the second
// same-name/same-region/different-account instance was silently dropped when
// selected by exact name or glob, while --all (no dedup) returned both — the two
// selection forms disagreed and the prod stack was never checked by any named leg.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

const discovered = [
  { stackName: 'App', region: 'us-east-1', account: '111111111111', template: { dev: true } },
  { stackName: 'App', region: 'us-east-1', account: '222222222222', template: { prod: true } },
  { stackName: 'Solo', region: 'us-east-1', account: '111111111111', template: {} },
];
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: () => Promise.resolve(discovered),
}));

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

describe('resolveStacks — exact name / glob select EVERY same-name+region account instance (#1320)', () => {
  it('exact name returns BOTH accounts (not just the first)', async () => {
    const out = await resolveStacks(args({ stackNames: ['App'] }));
    expect(out.map((s) => s.account).sort()).toEqual(['111111111111', '222222222222']);
    // each instance carries its OWN synth template — the drop bug would have lost prod
    expect(out.map((s) => s.template)).toEqual(
      expect.arrayContaining([{ dev: true }, { prod: true }])
    );
  });

  it('glob returns BOTH accounts', async () => {
    const out = await resolveStacks(args({ stackNames: ['App*'] }));
    expect(out.map((s) => s.account).sort()).toEqual(['111111111111', '222222222222']);
  });

  it('--all returns BOTH accounts (parity with named selection)', async () => {
    const out = await resolveStacks(args({ all: true }));
    const app = out.filter((s) => s.stackName === 'App');
    expect(app.map((s) => s.account).sort()).toEqual(['111111111111', '222222222222']);
  });

  it('exact-name and glob resolve the SAME set (the two forms must not disagree)', async () => {
    const exact = await resolveStacks(args({ stackNames: ['App'] }));
    const glob = await resolveStacks(args({ stackNames: ['App*'] }));
    expect(exact.map((s) => s.account).sort()).toEqual(glob.map((s) => s.account).sort());
  });

  it('a TRUE duplicate (same name + region + account) still collapses to one', async () => {
    // `App App` (exact name twice) must not multiply the per-account instances:
    // add() dedups on name+region+account, so each account still appears exactly once.
    const out = await resolveStacks(args({ stackNames: ['App', 'App'] }));
    const app = out.filter((s) => s.stackName === 'App');
    expect(app).toHaveLength(2); // two ACCOUNTS, once each — NOT four
    expect(app.map((s) => s.account).sort()).toEqual(['111111111111', '222222222222']);
  });
});

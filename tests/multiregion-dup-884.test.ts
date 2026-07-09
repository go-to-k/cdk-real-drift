import { describe, expect, it, vi } from 'vite-plus/test';

// resolveStacks synthesizes a CDK app (resolveApp) and discovers its stacks
// (discoverStacks) — both heavy. Mock them: resolveApp returns a truthy app,
// discoverStacks returns a fixed set so the exact-name / glob matching can be
// exercised in isolation. Here the app defines the SAME stackName in two
// regions (a supported multi-region shape — check.ts keys --pre-deploy synth
// templates by name+region for exactly this).
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

const discovered = [
  { stackName: 'Dup', region: 'us-east-1', template: { east: true } },
  { stackName: 'Dup', region: 'us-west-2', template: { west: true } },
  { stackName: 'Solo', region: 'us-east-1', template: {} },
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
    verbose: false,
    waitMs: undefined,
    ...overrides,
  };
}

describe('resolveStacks — exact name selects EVERY same-named region instance (#884)', () => {
  it('returns BOTH regions for an exact same-name selection (not just the first)', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dup'] }));
    expect(out.map((s) => s.region).sort()).toEqual(['us-east-1', 'us-west-2']);
    // each instance carries its OWN synth template — the drop bug would have lost west
    expect(out.map((s) => s.template)).toEqual(
      expect.arrayContaining([{ east: true }, { west: true }])
    );
  });

  it('parity with the glob branch — `Dup*` and exact `Dup` resolve the same set', async () => {
    const exact = await resolveStacks(args({ stackNames: ['Dup'] }));
    const glob = await resolveStacks(args({ stackNames: ['Dup*'] }));
    expect(exact.map((s) => s.region).sort()).toEqual(glob.map((s) => s.region).sort());
  });

  it('still dedups a same-name same-region instance to one entry', async () => {
    // `Dup Dup` (exact name twice) must not double it; add() dedups on name+region.
    const out = await resolveStacks(args({ stackNames: ['Dup', 'Dup'] }));
    expect(out.filter((s) => s.stackName === 'Dup')).toHaveLength(2); // two REGIONS, once each
  });

  it('leaves a single-instance exact name unaffected', async () => {
    const out = await resolveStacks(args({ stackNames: ['Solo'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Solo']);
  });

  it('still throws for an unknown exact name', async () => {
    await expect(resolveStacks(args({ stackNames: ['Missing'] }))).rejects.toThrow(
      /stack "Missing" is not defined by the CDK app/
    );
  });
});

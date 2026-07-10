import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #957: `resolveStacks` must resolve the profile-region fallback BEFORE the discovery
// synth (`discoverStacks`), not after. `check --pre-deploy` synthesizes the app twice
// (once for discovery, once for the local-template override); if `a.region` is only
// backfilled AFTER discovery, the second synth's subprocess sees an AWS_REGION the
// first did not, so an app branching on process.env.AWS_REGION synthesizes a different
// stack set / template across the two passes. These tests assert the ORDERING by
// capturing the `region` `discoverStacks` was actually called with.

// resolveApp is heavy (reads cdk.json / a cloud assembly) — mock to a truthy app.
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

// Capture the opts `discoverStacks` is called with so we can assert the region passed
// into the discovery synth. The returned stack set is swappable per-test via
// `discoverResult`; the default is one env-agnostic stack (region: undefined) so the
// fallback path is exercised.
interface Disc {
  stackName: string;
  region: string | undefined;
  template: Record<string, unknown>;
}
const discoverCalls: Array<{ region: string | undefined }> = [];
let discoverResult: Disc[] = [{ stackName: 'Dev', region: undefined, template: {} }];
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: (_app: string, opts: { region?: string | undefined } = {}) => {
    discoverCalls.push({ region: opts.region });
    return Promise.resolve(discoverResult);
  },
}));

import type { CommonArgs } from '../src/cli-args.js';
import { resolveStacks } from '../src/commands/resolve-stacks.js';

function args(overrides: Partial<CommonArgs>): CommonArgs {
  return {
    stackNames: [],
    all: false,
    region: undefined,
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

describe('resolveStacks — profile-region backfill happens BEFORE discovery (#957)', () => {
  let tmp: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};
  const ENVS = [
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
  ];

  beforeEach(() => {
    discoverCalls.length = 0;
    discoverResult = [{ stackName: 'Dev', region: undefined, template: {} }];
    for (const k of ENVS) saved[k] = process.env[k];
    // A profile's region must come from the shared config file alone — clear any
    // ambient region/profile env that would otherwise win in the provider chain.
    for (const k of ENVS) delete process.env[k];
    // Never let a real IMDS probe run (and hang) in CI.
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    tmp = mkdtempSync(join(tmpdir(), 'cdkrd-957-'));
    configPath = join(tmp, 'config');
    writeFileSync(
      configPath,
      [
        '[profile haszone]',
        'region = eu-west-2',
        '',
        '[profile noregion]',
        'output = json',
        '',
      ].join('\n')
    );
    process.env.AWS_CONFIG_FILE = configPath;
    // Point the credentials file at a nonexistent path so the `[default]`-ini fallback
    // resolves nothing for the `noregion` case (isolates the profile-region source).
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmp, 'no-such-credentials');
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the profile region and passes it INTO discoverStacks when a.region is unset', async () => {
    const a = args({ profile: 'haszone' });
    const out = await resolveStacks(a);
    // The hoist: the discovery synth saw the profile region — proving it was resolved
    // BEFORE discovery, so the later --pre-deploy synth gets the same region env.
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0]!.region).toBe('eu-west-2');
    // a.region is backfilled (the downstream `?? a.region` / synthKey site) and the
    // env-agnostic stack resolves to it.
    expect(a.region).toBe('eu-west-2');
    expect(out).toEqual([{ stackName: 'Dev', region: 'eu-west-2', template: {} }]);
  });

  it('does NOT call resolveProfileRegion when a.region is already explicit (no regression)', async () => {
    const a = args({ region: 'us-east-1', profile: 'haszone' });
    const out = await resolveStacks(a);
    // Explicit --region / $AWS_REGION: discovery gets the explicit region unchanged,
    // and the profile-region path is not consulted (a.region stays as given even though
    // the `haszone` profile would resolve to eu-west-2).
    expect(discoverCalls[0]!.region).toBe('us-east-1');
    expect(a.region).toBe('us-east-1');
    expect(out).toEqual([{ stackName: 'Dev', region: 'us-east-1', template: {} }]);
  });

  it('leaves a.region undefined when resolveProfileRegion resolves nothing (behavior unchanged)', async () => {
    const a = args({ profile: 'noregion' });
    const out = await resolveStacks(a);
    // Nothing resolves → discovery gets undefined and the env-agnostic stack ends up
    // region undefined, exactly as before the hoist (the loud "no region" error is left
    // to fire downstream as the last resort — no silent us-east-1).
    expect(discoverCalls[0]!.region).toBeUndefined();
    expect(a.region).toBeUndefined();
    expect(out).toEqual([{ stackName: 'Dev', region: undefined, template: {} }]);
  });
});

describe('resolveStacks — a region-pinned stack keeps its own region (#957)', () => {
  let tmp: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};
  const ENVS = [
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
  ];

  beforeEach(() => {
    discoverCalls.length = 0;
    // A region-pinned stack: its own concrete env.region should win over the fallback.
    discoverResult = [{ stackName: 'Pinned', region: 'ap-northeast-1', template: {} }];
    for (const k of ENVS) saved[k] = process.env[k];
    for (const k of ENVS) delete process.env[k];
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    tmp = mkdtempSync(join(tmpdir(), 'cdkrd-957b-'));
    configPath = join(tmp, 'config');
    writeFileSync(configPath, ['[profile haszone]', 'region = eu-west-2', ''].join('\n'));
    process.env.AWS_CONFIG_FILE = configPath;
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmp, 'no-such-credentials');
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('an env-pinned stack keeps its OWN env.region, not the profile fallback', async () => {
    const a = args({ profile: 'haszone' });
    const out = await resolveStacks(a);
    // The profile region is still resolved & passed to discovery (the hoist), but the
    // stack's own concrete region wins for the resolved result — only env-agnostic
    // stacks fall back.
    expect(discoverCalls[0]!.region).toBe('eu-west-2');
    expect(out).toEqual([{ stackName: 'Pinned', region: 'ap-northeast-1', template: {} }]);
  });
});

// #907: CDK synthesizes an app with unresolved context lookups by filling every gap with a
// well-known DUMMY value (vpc-12345, ...) and recording the gap in the manifest's `missing`
// array. cdkrd used to ignore `missing` entirely, so under --pre-deploy the fabricated
// template became the DECLARED source → guaranteed false declared drift (and a revert that
// would write vpc-12345 back). These tests pin the pure helpers that drive the new surface:
// a warning on discovery, an escalated REFUSAL under --pre-deploy.
import { describe, expect, it } from 'vite-plus/test';
import type { CloudAssemblyLike } from '../src/synth/missing-context.js';
import {
  collectMissingRecursively,
  missingContextKeys,
  missingContextWarning,
} from '../src/synth/missing-context.js';

const entry = (key: string) => ({ key, provider: 'vpc-provider', props: {} });

// Build a CloudAssembly-shaped stub (structural — mirrors cx-api's `manifest.missing` +
// `nestedAssemblies[].nestedAssembly`) for the recursive-aggregation tests (#987).
const asm = (missing: { key: string }[], nested: CloudAssemblyLike[] = []): CloudAssemblyLike => ({
  manifest: { missing },
  nestedAssemblies: nested.map((nestedAssembly) => ({ nestedAssembly })),
});

describe('missingContextKeys (#907)', () => {
  it('is empty for undefined / empty missing (a clean assembly)', () => {
    expect(missingContextKeys(undefined)).toEqual([]);
    expect(missingContextKeys([])).toEqual([]);
  });

  it('extracts, dedups by key, and sorts', () => {
    const keys = missingContextKeys([
      entry('vpc-provider:account=1:filter.vpc-name=main'),
      entry('availability-zones:account=1:region=us-east-1'),
      entry('vpc-provider:account=1:filter.vpc-name=main'), // duplicate key
    ]);
    expect(keys).toEqual([
      'availability-zones:account=1:region=us-east-1',
      'vpc-provider:account=1:filter.vpc-name=main',
    ]);
  });
});

describe('missingContextWarning (#907)', () => {
  it('returns null when nothing is missing (behavior unchanged for a clean assembly)', () => {
    expect(missingContextWarning([])).toBeNull();
  });

  it('names the missing keys and count (discovery warning)', () => {
    const msg = missingContextWarning(['vpc-provider:xyz', 'availability-zones:abc'])!;
    expect(msg).toContain('2 unresolved context lookup(s)');
    expect(msg).toContain('vpc-provider:xyz');
    expect(msg).toContain('availability-zones:abc');
    expect(msg).toContain('vpc-12345'); // explains the dummy placeholders
    // discovery mode does NOT escalate
    expect(msg).not.toContain('refusing');
    expect(msg).not.toContain('--pre-deploy');
  });

  it('escalates to a refusal under --pre-deploy and still names the keys', () => {
    const msg = missingContextWarning(['vpc-provider:xyz'], { preDeploy: true })!;
    expect(msg).toContain('vpc-provider:xyz');
    expect(msg).toContain('(--pre-deploy) refusing');
    expect(msg).toContain('revert would write the dummy values back');
    expect(msg).toContain('cdk.context.json');
  });

  it('returns null under --pre-deploy too when nothing is missing (no false refusal)', () => {
    expect(missingContextWarning([], { preDeploy: true })).toBeNull();
  });
});

describe('collectMissingRecursively (#987)', () => {
  it('returns the top-level assembly missing entries (no nested assemblies)', () => {
    const found = collectMissingRecursively(asm([entry('vpc-provider:top')]));
    expect(found.map((m) => m.key)).toEqual(['vpc-provider:top']);
  });

  it('is empty for a clean assembly (no missing, no nested)', () => {
    expect(collectMissingRecursively(asm([]))).toEqual([]);
  });

  it('descends into a nested-Stage assembly whose missing the top-level omits (#987)', () => {
    // The Stage's stack records its unresolved lookup in the NESTED manifest; the top-level
    // manifest is empty. A top-level-only read (the #907 guard) would miss it entirely.
    const found = collectMissingRecursively(asm([], [asm([entry('vpc-provider:inside-stage')])]));
    expect(found.map((m) => m.key)).toEqual(['vpc-provider:inside-stage']);
  });

  it('aggregates across a deeply-nested (Stage-in-Stage) topology', () => {
    const found = collectMissingRecursively(
      asm(
        [entry('vpc-provider:top')],
        [
          asm([entry('vpc-provider:stage1')], [asm([entry('availability-zones:stage1.stage2')])]),
          asm([entry('vpc-provider:stage2')]),
        ]
      )
    );
    // Feeding through missingContextKeys dedups + sorts — the real synth.ts wiring.
    expect(missingContextKeys(found)).toEqual([
      'availability-zones:stage1.stage2',
      'vpc-provider:stage1',
      'vpc-provider:stage2',
      'vpc-provider:top',
    ]);
  });
});

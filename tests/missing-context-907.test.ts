// #907: CDK synthesizes an app with unresolved context lookups by filling every gap with a
// well-known DUMMY value (vpc-12345, ...) and recording the gap in the manifest's `missing`
// array. cdkrd used to ignore `missing` entirely, so under --pre-deploy the fabricated
// template became the DECLARED source → guaranteed false declared drift (and a revert that
// would write vpc-12345 back). These tests pin the pure helpers that drive the new surface:
// a warning on discovery, an escalated REFUSAL under --pre-deploy.
import { describe, expect, it } from 'vite-plus/test';
import { missingContextKeys, missingContextWarning } from '../src/synth/missing-context.js';

const entry = (key: string) => ({ key, provider: 'vpc-provider', props: {} });

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

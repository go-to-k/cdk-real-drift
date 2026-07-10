import { describe, expect, it } from 'vite-plus/test';
import { formatFinding } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

// #758 follow-up: applyBaseline threads a CHANGED recorded undeclared value's OLD baseline
// value onto `f.desired`, so the check report should render a `recorded → live` delta
// (baseline-vs-actual, mirroring the `added` tier) instead of only the live value — a user
// reading `check` output must see WHAT the value changed FROM, not just the (possibly
// attacker-set) live side.
describe('#758 fu: a CHANGED recorded undeclared finding renders recorded-vs-live, not just actual', () => {
  it('a changed undeclared SCALAR (desired=old, actual=new) shows BOTH the recorded and the live value', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'L',
      resourceType: 'AWS::S3::Bucket',
      path: 'OwnershipControls.Rules[0].ObjectOwnership',
      desired: 'BucketOwnerEnforced',
      actual: 'ObjectWriter',
      note: 'changed since record',
    };
    const out = formatFinding(f);
    // both sides are visible — the OLD recorded value AND the live value
    expect(out).toContain('baseline=');
    expect(out).toContain('actual  =');
    expect(out).toContain('BucketOwnerEnforced');
    expect(out).toContain('ObjectWriter');
    // NOT the single bare `actual =` line (that would hide what it changed from)
    expect(out).not.toContain('\n      actual =');
  });

  it('a changed undeclared MAP (both objects) renders a per-KEY delta', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'L',
      resourceType: 'AWS::IAM::Role',
      path: 'Tags',
      desired: { Env: 'prod', Owner: 'team' },
      actual: { Env: 'staging', Owner: 'team' },
      note: 'changed since record',
    };
    const out = formatFinding(f);
    // per-key delta: only the diverging key (Env) is shown, with baseline/actual sides
    expect(out).toContain('~ Env');
    expect(out).toContain('baseline=');
    expect(out).toContain('actual  =');
    expect(out).toContain('prod');
    expect(out).toContain('staging');
    // the unchanged key (Owner) is not surfaced
    expect(out).not.toContain('~ Owner');
  });

  it('regression: a NEW undeclared value (no desired) keeps the single `actual =` line, no spurious recorded line', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'L',
      resourceType: 'AWS::Lambda::Function',
      path: 'Layers',
      actual: ['arn:aws:lambda:us-east-1:1234:layer:x:1'],
    };
    const out = formatFinding(f);
    expect(out).toContain('\n      actual =');
    expect(out).not.toContain('baseline=');
    expect(out).not.toContain('recorded=');
  });

  it('regression: an undeclared finding with arrayDelta still renders the array delta (unchanged, takes precedence over desired)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'L',
      resourceType: 'AWS::X::Y',
      path: 'Arr',
      // even with a desired present, arrayDelta must win (it is the WHICH-element view)
      desired: [{ Name: 'a', v: 1 }],
      actual: [{ Name: 'a', v: 2 }],
      arrayDelta: {
        identityField: 'Name',
        added: [],
        changed: [{ id: 'a', recorded: { Name: 'a', v: 1 }, actual: { Name: 'a', v: 2 } }],
        removed: [],
      },
    };
    const out = formatFinding(f);
    expect(out).toContain('Name-keyed element(s) changed');
    expect(out).toContain('~ [a]');
  });

  it('regression: atDefault / generated tiers are unaffected (single actual = line, no recorded side)', () => {
    for (const tier of ['atDefault', 'generated'] as const) {
      const f: Finding = {
        tier,
        logicalId: 'L',
        resourceType: 'AWS::X::Y',
        path: 'P',
        actual: 'v',
      };
      const out = formatFinding(f);
      expect(out).toContain('\n      actual =');
      expect(out).not.toContain('baseline=');
    }
  });
});

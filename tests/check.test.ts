import { describe, expect, it } from 'vite-plus/test';
import {
  finalCheckExit,
  preDeployFindings,
  undeclaredOnlyFindings,
} from '../src/commands/check.js';
import {
  buildResolveOptions,
  keyOf,
  postRecordNote,
  resolveMenuMessage,
} from '../src/commands/interactive-resolve.js';
import type { Actions } from '../src/commands/stack-actions.js';
import type { Finding } from '../src/types.js';

const F = (tier: Finding['tier'], path = 'P'): Finding => ({
  tier,
  logicalId: 'L',
  resourceType: 'AWS::X::Y',
  path,
});

describe('preDeployFindings (--pre-deploy scope)', () => {
  it('drops all undeclared-side tiers (undeclared / generated / atDefault)', () => {
    const out = preDeployFindings([
      F('declared'),
      F('undeclared'),
      F('generated'),
      F('atDefault'),
      F('undeclared', 'Q'),
    ]);
    expect(out.map((f) => f.tier)).toEqual(['declared']);
  });

  it('keeps declared / deleted / readGap / unresolved / skipped', () => {
    const kept: Finding['tier'][] = ['deleted', 'declared', 'readGap', 'unresolved', 'skipped'];
    const out = preDeployFindings(kept.map((t) => F(t)));
    expect(out.map((f) => f.tier)).toEqual(kept);
  });

  it('is a no-op when there are no undeclared findings (regression)', () => {
    const findings = [F('declared'), F('readGap')];
    expect(preDeployFindings(findings)).toEqual(findings);
  });
});

describe('undeclaredOnlyFindings (R59 — pair-with-cdk-drift scope)', () => {
  it('drops declared findings AND declared-comparison byproducts (readGap/unresolved)', () => {
    const out = undeclaredOnlyFindings([
      F('declared'),
      F('undeclared'),
      F('readGap', 'Q'),
      F('unresolved', 'R'),
    ]);
    expect(out.map((f) => f.tier)).toEqual(['undeclared']);
  });

  it('keeps deleted (a gone resource has no undeclared values; silence would lie) and skipped', () => {
    const kept: Finding['tier'][] = ['deleted', 'undeclared', 'skipped'];
    const out = undeclaredOnlyFindings(kept.map((t) => F(t)));
    expect(out.map((f) => f.tier)).toEqual(kept);
  });
});

describe('postRecordNote (R52 — a partial record is a SUCCESS, said plainly)', () => {
  it('partial record (undeclared remain) → success; remainder surfaces from the next check', () => {
    const note = postRecordNote(112, 0);
    expect(note).toContain('record succeeded');
    expect(note).toContain('112 unrecorded value(s) stay reported from the next check on');
  });

  it('everything recorded → CLEAN', () => {
    expect(postRecordNote(0, 0)).toBe('stack is now CLEAN.');
  });

  it("declared/deleted drift remains → named (outside record's reach), undeclared remainder too", () => {
    const note = postRecordNote(112, 2);
    expect(note).toContain('2 declared/deleted drift(s) remain un-addressed');
    expect(note).toContain('112 unrecorded value(s) also stay reported');
  });

  it('declared drift remains, nothing else → no undeclared clause', () => {
    const note = postRecordNote(0, 1);
    expect(note).toContain('declared/deleted drift(s) remain');
    expect(note).not.toContain('also stay reported');
  });
});

describe('buildResolveOptions (R133 — the chain menu surface)', () => {
  const A = (over: Partial<Actions>): Actions => ({
    record: false,
    ignore: false,
    revert: false,
    ...over,
  });
  const values = (a: Actions, decidable: number): string[] =>
    buildResolveOptions(a, decidable).map((o) => o.value);

  it('Nothing is always FIRST (safe no-op as the default cursor)', () => {
    expect(values(A({}), 0)[0]).toBe('nothing');
    expect(values(A({ record: true, revert: true, ignore: true }), 5)[0]).toBe('nothing');
  });

  it('each bulk option appears only when its action applies', () => {
    expect(values(A({ record: true }), 0)).toEqual(['nothing', 'record-all']);
    expect(values(A({ revert: true }), 0)).toEqual(['nothing', 'revert-all']);
    expect(values(A({ ignore: true }), 0)).toEqual(['nothing', 'ignore-all']);
  });

  it('order is record → revert → ignore after Nothing', () => {
    expect(values(A({ record: true, revert: true, ignore: true }), 1)).toEqual([
      'nothing',
      'record-all',
      'revert-all',
      'ignore-all',
    ]);
  });

  it('per-finding appears only when >1 finding is decidable', () => {
    expect(values(A({ revert: true }), 1)).not.toContain('per-finding');
    expect(values(A({ revert: true }), 2)).toContain('per-finding');
  });
});

describe('resolveMenuMessage (R133 — worded by remaining exit state)', () => {
  it('code 1 (drift remains) says drift found', () => {
    expect(resolveMenuMessage('S', 1)).toContain('drift found');
  });
  it('code 0 (only unrecorded) says unrecorded values found', () => {
    expect(resolveMenuMessage('S', 0)).toContain('unrecorded values found');
  });
});

describe('finalCheckExit (R53 — report-only by default, --fail opts into exit 1)', () => {
  it('without --fail, drift (1) maps to 0 — report-only', () => {
    expect(finalCheckExit(1, false)).toBe(0);
  });

  it('with --fail, drift stays 1', () => {
    expect(finalCheckExit(1, true)).toBe(1);
  });

  it('clean stays 0 either way', () => {
    expect(finalCheckExit(0, false)).toBe(0);
    expect(finalCheckExit(0, true)).toBe(0);
  });

  it('errors (2) ALWAYS propagate, with or without --fail', () => {
    expect(finalCheckExit(2, false)).toBe(2);
    expect(finalCheckExit(2, true)).toBe(2);
  });
});

describe('keyOf (per-finding identity — ELB attribute-bag collision guard)', () => {
  const elb = (attributeKey: string): Finding => ({
    tier: 'declared',
    logicalId: 'LB',
    resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    path: 'LoadBalancerAttributes',
    attributeKey,
    desired: 'x',
    actual: 'y',
  });

  it('gives two attributes of one bag DISTINCT keys (same logicalId+path)', () => {
    const a = elb('idle_timeout.timeout_seconds');
    const b = elb('deletion_protection.enabled');
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('selecting one attribute does NOT re-admit the other (the revert-skip safety bug)', () => {
    const a = elb('idle_timeout.timeout_seconds');
    const b = elb('deletion_protection.enabled');
    const chosen = new Set([keyOf(a)]); // user picked revert for `a`, skip for `b`
    const readmitted = [a, b].filter((f) => chosen.has(keyOf(f)));
    expect(readmitted).toEqual([a]); // ONLY a — b (skipped) is not reverted
  });

  it('a finding without attributeKey keeps the bare logicalId::path key', () => {
    const f: Finding = { tier: 'undeclared', logicalId: 'R', resourceType: 'T', path: 'P' };
    expect(keyOf(f)).toBe('R::P');
  });
});

import { describe, expect, it } from 'vite-plus/test';
import {
  coverageWarning,
  finalCheckExit,
  hasCoverageGap,
  nestedStackWarning,
  preDeployFindings,
  reconcileBaseline,
  strictCoverageExit,
  synthKey,
  undeclaredOnlyFindings,
} from '../src/commands/check.js';
import {
  buildResolveOptions,
  keyOf,
  postRecordNote,
  resolveMenuMessage,
} from '../src/commands/interactive-resolve.js';
import type { Actions } from '../src/commands/stack-actions.js';
import type { DesiredResource, Finding } from '../src/types.js';

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

describe('reconcileBaseline (--show-all inventory tags live-only as unrecorded, not drift)', () => {
  // The pre-#378 bug: --show-all bypassed applyBaseline, so a fresh deploy's
  // undeclared inventory stayed untagged and the report mislabeled it as
  // "CFn-Undeclared Drift" / "N drift(s)" — and `--show-all --fail` exited 1 on a
  // stack nobody had touched. --show-all loads baseline=undefined; reconcileBaseline
  // must still route through applyBaseline so those values are tagged `unrecorded`.
  it('--show-all (baseline undefined): undeclared + added are tagged unrecorded', () => {
    const out = reconcileBaseline([F('undeclared'), F('added'), F('declared')], undefined, {
      declaredOnly: false,
      applyOpts: {},
    });
    const byTier = Object.fromEntries(out.map((f) => [f.tier, f.unrecorded]));
    expect(byTier.undeclared).toBe(true); // potential drift, not confirmed drift
    expect(byTier.added).toBe(true);
    expect(byTier.declared).toBeUndefined(); // a real declared drift still counts
  });

  it('--declared-only is the ONLY mode that bypasses the baseline (raw passthrough)', () => {
    const findings = [F('declared'), F('undeclared')];
    const out = reconcileBaseline(findings, undefined, { declaredOnly: true, applyOpts: {} });
    expect(out).toBe(findings); // untouched reference: applyBaseline never ran
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
    expect(note).toContain('2 declared/deleted/added drift(s) remain un-addressed');
    expect(note).toContain('112 unrecorded value(s) also stay reported');
  });

  it('declared drift remains, nothing else → no undeclared clause', () => {
    const note = postRecordNote(0, 1);
    expect(note).toContain('declared/deleted/added drift(s) remain');
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

  it('R141: the Record label is worded per recordLabel kind (snapshot / establish / establish-drift / establish-deleted)', () => {
    const label = (
      kind: 'snapshot' | 'establish' | 'establish-drift' | 'establish-deleted'
    ): string =>
      buildResolveOptions(A({ record: true }), 0, kind).find((o) => o.value === 'record-all')!
        .label;
    // clean establish: "baseline", never "undeclared"
    expect(label('establish')).toContain('Record current state as the .cdkrd baseline');
    expect(label('establish')).not.toContain('undeclared');
    // plain snapshot: "undeclared"
    expect(label('snapshot')).toContain('Record undeclared');
    // establish next to a declared drift: still a baseline establish, but honest that the
    // declared drift stays reported (so it never reads as "all done").
    expect(label('establish-drift')).toContain('Record current state as the .cdkrd baseline');
    expect(label('establish-drift')).toContain('declared drift stays reported');
    // establish next to a DELETED declared resource: hint is re-deploy, not revert/ignore.
    expect(label('establish-deleted')).toContain('deleted-resource drift stays reported');
    expect(label('establish-deleted')).toContain('re-deploy to restore it');
  });
});

describe('resolveMenuMessage (R133 — worded by remaining exit state)', () => {
  it('code 1 (drift remains) says drift found', () => {
    expect(resolveMenuMessage('S', 1)).toContain('drift found');
  });
  it('code 0 (only unrecorded) says potential drift found', () => {
    expect(resolveMenuMessage('S', 0)).toContain('potential drift found');
  });
  it('R141: establishOnly says "no .cdkrd baseline yet"', () => {
    expect(resolveMenuMessage('S', 0, true)).toContain('no .cdkrd baseline yet');
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

describe('nestedStackWarning (loud coverage gap for nested stacks)', () => {
  const r = (resourceType: string, over: Partial<DesiredResource> = {}): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    declared: {},
    ...over,
  });

  it('returns null when there are no nested stacks', () => {
    expect(nestedStackWarning([r('AWS::SNS::Topic'), r('AWS::S3::Bucket')], 'S')).toBeNull();
  });

  it('warns, counts, and lists nested stacks by construct path (sorted)', () => {
    const w = nestedStackWarning(
      [
        r('AWS::CloudFormation::Stack', { logicalId: 'B', constructPath: 'S/Zeta' }),
        r('AWS::SNS::Topic'),
        r('AWS::CloudFormation::Stack', { logicalId: 'A', constructPath: 'S/Alpha' }),
      ],
      'MyStack'
    );
    expect(w).toContain('MyStack has 2 nested CloudFormation stack(s)');
    expect(w).toContain('NOT checked');
    expect(w).toContain('S/Alpha, S/Zeta'); // sorted, construct paths preferred
  });

  it('falls back to logicalId when no construct path', () => {
    const w = nestedStackWarning(
      [r('AWS::CloudFormation::Stack', { logicalId: 'NestedXYZ' })],
      'S'
    );
    expect(w).toContain('NestedXYZ');
  });
});

describe('coverageWarning / hasCoverageGap (--strict + loud coverage gap)', () => {
  const skipped = (logicalId: string, over: Partial<Finding> = {}): Finding => ({
    tier: 'skipped',
    logicalId,
    resourceType: 'AWS::X::Y',
    path: '',
    ...over,
  });
  const dr = (resourceType: string): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    declared: {},
  });

  it('coverageWarning is null when nothing was skipped', () => {
    expect(coverageWarning([F('undeclared'), F('declared')], 'S')).toBeNull();
  });

  it('coverageWarning counts + lists skipped resources (construct path preferred, sorted)', () => {
    const w = coverageWarning(
      [
        skipped('B', { constructPath: 'S/Zeta' }),
        F('declared'),
        skipped('A', { constructPath: 'S/Alpha' }),
      ],
      'MyStack'
    );
    expect(w).toContain('MyStack: 2 resource(s) were NOT checked (coverage incomplete)');
    expect(w).toContain('S/Alpha, S/Zeta');
  });

  it('coverageWarning caps the list at 10 with a "+N more" suffix', () => {
    const many = Array.from({ length: 14 }, (_, i) => skipped(`R${String(i).padStart(2, '0')}`));
    const w = coverageWarning(many, 'S')!;
    expect(w).toContain('14 resource(s) were NOT checked');
    expect(w).toContain('…(+4 more)');
  });

  it('hasCoverageGap is true on a skipped resource', () => {
    expect(hasCoverageGap([skipped('A')], [dr('AWS::SNS::Topic')])).toBe(true);
  });

  it('hasCoverageGap is true on a nested stack even with everything else checked', () => {
    expect(hasCoverageGap([F('undeclared')], [dr('AWS::CloudFormation::Stack')])).toBe(true);
  });

  it('hasCoverageGap is false when everything was read and there are no nested stacks', () => {
    expect(hasCoverageGap([F('undeclared'), F('declared')], [dr('AWS::SNS::Topic')])).toBe(false);
  });

  it('strictCoverageExit is 1 only when --strict AND a coverage gap (else 0)', () => {
    const gap = [skipped('A')];
    const clean = [F('declared')];
    const res = [dr('AWS::SNS::Topic')];
    expect(strictCoverageExit(true, gap, res)).toBe(1); // strict + gap → fail
    expect(strictCoverageExit(false, gap, res)).toBe(0); // gap but no --strict → 0
    expect(strictCoverageExit(true, clean, res)).toBe(0); // strict but no gap → 0
    // a nested stack is a coverage gap too (the value shared with the --pre-deploy path)
    expect(strictCoverageExit(true, clean, [dr('AWS::CloudFormation::Stack')])).toBe(1);
  });
});

describe('synthKey (--pre-deploy template keyed by name + region, WAVE21)', () => {
  it('distinguishes the same stack name across regions (no template collision)', () => {
    expect(synthKey('MyStack', 'us-east-1')).not.toBe(synthKey('MyStack', 'eu-west-1'));
  });
  it('is stable for the same name + region', () => {
    expect(synthKey('MyStack', 'us-east-1')).toBe(synthKey('MyStack', 'us-east-1'));
  });
  it('treats an undefined (env-agnostic) region as a distinct, stable key', () => {
    expect(synthKey('MyStack', undefined)).toBe(synthKey('MyStack', undefined));
    expect(synthKey('MyStack', undefined)).not.toBe(synthKey('MyStack', 'us-east-1'));
  });
});

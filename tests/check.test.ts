import { describe, expect, it } from 'vite-plus/test';
import {
  finalCheckExit,
  preDeployFindings,
  undeclaredOnlyFindings,
} from '../src/commands/check.js';
import { postRecordNote } from '../src/commands/interactive-resolve.js';
import type { Finding } from '../src/types.js';

const F = (tier: Finding['tier'], path = 'P'): Finding => ({
  tier,
  logicalId: 'L',
  resourceType: 'AWS::X::Y',
  path,
});

describe('preDeployFindings (--pre-deploy scope)', () => {
  it('drops undeclared findings (meaningless against a synth declared set)', () => {
    const out = preDeployFindings([F('declared'), F('undeclared'), F('undeclared', 'Q')]);
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

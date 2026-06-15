import { describe, expect, it } from 'vite-plus/test';
import {
  finalCheckExit,
  firstRunPrompt,
  postAcceptNote,
  preDeployFindings,
  undeclaredOnlyFindings,
} from '../src/commands/check.js';
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

describe('firstRunPrompt (R45/R105 — the no-baseline decision must be informed, framed as baseline setup)', () => {
  it('frames the run as baseline SETUP and does not read as a drift count (R49/R105)', () => {
    const { message } = firstRunPrompt('ApiStack', { standout: 113 });
    expect(message).toContain('ApiStack: no baseline yet');
    expect(message).toContain('this first run SETS UP your baseline');
    expect(message).toContain('Found 113 live value(s) not declared in your template');
    expect(message).toContain('113 stand out as possible out-of-band edits');
    expect(message).toContain('Declared-side drift is reported either way');
    expect(message).not.toContain('drift(s) found'); // it must never read as a drift verdict
  });

  it('declared-side drift present → the prompt says it was FOUND, with its count (R51)', () => {
    const { message } = firstRunPrompt('ApiStack', { standout: 113, declaredDrift: 3 });
    expect(message).toContain(
      'Also found 3 declared-side drift(s) — reported below whichever you choose.'
    );
    expect(message).not.toContain('either way'); // the generic clause is replaced, not appended
  });

  it('the "found N" total is the COMPLETE inventory; only STANDOUT is called an edit, folded remainder named separately (R86/R104/R105)', () => {
    // 7 top-level edits + 50 nested (folded) + 152 atDefault + 5 generated = 214 not-declared
    const { message, options } = firstRunPrompt('ApiStack', {
      standout: 7,
      nested: 50,
      atDefault: 152,
      generated: 5,
    });
    expect(message).toContain('Found 214 live value(s) not declared in your template');
    // ONLY the 7 top-level values are called edits — the 50 nested are NOT (the R105 fix)
    expect(message).toContain('7 stand out as possible out-of-band edits');
    expect(message).toContain(
      'the other 207 fold as AWS defaults / auto-generated / nested sub-keys'
    );
    expect(message).not.toContain('57 stand out'); // nested must NOT be counted as edits
    // accept records standout + nested (atDefault/generated never) = 57
    const bulk = options.find((o) => o.value === 'acceptAll')!;
    expect(bulk.label).toContain('Accept ALL 57');
    expect(message).toContain('Accept records the current state (57 value(s)) as your baseline');
  });

  it('zero standout (only nested/folded) → says nothing stands out, still offers the baseline (R105)', () => {
    const { message, options } = firstRunPrompt('ApiStack', {
      standout: 0,
      nested: 50,
      generated: 5,
    });
    expect(message).toContain('none stand out as out-of-band edits');
    expect(message).toContain('Found 55 live value(s) not declared');
    // accept still records the 50 nested (generated is not recorded)
    expect(options.find((o) => o.value === 'acceptAll')!.label).toContain('Accept ALL 50');
  });

  it('no declared-side drift → the generic either-way clause (R51)', () => {
    const { message } = firstRunPrompt('ApiStack', { standout: 113 });
    expect(message).toContain('Declared-side drift is reported either way.');
    expect(message).not.toContain('Also found');
  });

  it('"Accept ALL" is the FIRST option (the common first-run choice — R52); show-first follows', () => {
    const { options } = firstRunPrompt('S', { standout: 5 });
    expect(options[0]!.value).toBe('acceptAll');
    expect(options[1]!.value).toBe('show');
    expect(options[1]!.label).toContain('Show them first');
    expect(options[1]!.label).toContain('accept (selectively) right after');
  });

  it('the bulk option states the recordable count and that values have NOT been reviewed', () => {
    const { options } = firstRunPrompt('S', { standout: 113 });
    const bulk = options.find((o) => o.value === 'acceptAll')!;
    expect(bulk.label).toContain('Accept ALL 113');
    expect(bulk.label).toContain('without reviewing them');
  });

  it('prompts speak the command vocabulary (accept) — no retired jargon', () => {
    const p = firstRunPrompt('S', { standout: 3 });
    const all = [p.message, ...p.options.map((o) => o.label)].join(' ');
    // the retired word is assembled at runtime so this file itself stays free of it (R46)
    expect(all.toLowerCase()).not.toContain(['b', 'less'].join(''));
  });
});

describe('postAcceptNote (R52 — a partial accept is a SUCCESS, said plainly)', () => {
  it('partial accept (undeclared remain) → success; remainder surfaces from the next check', () => {
    const note = postAcceptNote(112, 0);
    expect(note).toContain('accept succeeded');
    expect(note).toContain('112 unaccepted value(s) stay reported from the next check on');
  });

  it('everything accepted → CLEAN', () => {
    expect(postAcceptNote(0, 0)).toBe('stack is now CLEAN.');
  });

  it("declared/deleted drift remains → named (outside accept's reach), undeclared remainder too", () => {
    const note = postAcceptNote(112, 2);
    expect(note).toContain('2 declared/deleted drift(s) remain un-addressed');
    expect(note).toContain('112 unaccepted value(s) also stay reported');
  });

  it('declared drift remains, nothing else → no undeclared clause', () => {
    const note = postAcceptNote(0, 1);
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

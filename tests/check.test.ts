import { describe, expect, it } from 'vite-plus/test';
import { firstRunPrompt, postAcceptNote, preDeployFindings } from '../src/commands/check.js';
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

describe('firstRunPrompt (R45 — the no-baseline decision must be informed)', () => {
  it('the message anchors "undeclared" to the template and does not read as a drift count (R49)', () => {
    const { message } = firstRunPrompt('ApiStack', 113);
    expect(message).toContain('ApiStack: no baseline yet');
    expect(message).toContain('found 113 live value(s) not declared in your template');
    expect(message).toContain('typically AWS defaults'); // first-run framing, not "113 problems"
    expect(message).toContain('Declared-side drift is reported either way');
    expect(message).not.toContain('drift(s) found'); // it must never read as a drift verdict
  });

  it('declared-side drift present → the prompt says it was FOUND, with its count (R51)', () => {
    const { message } = firstRunPrompt('ApiStack', 113, 3);
    expect(message).toContain(
      'Also found 3 declared-side drift(s) — reported below whichever you choose.'
    );
    expect(message).not.toContain('either way'); // the generic clause is replaced, not appended
  });

  it('no declared-side drift → the generic either-way clause (R51)', () => {
    const { message } = firstRunPrompt('ApiStack', 113, 0);
    expect(message).toContain('Declared-side drift is reported either way.');
    expect(message).not.toContain('Also found');
  });

  it('"Accept ALL" is the FIRST option (the common first-run choice — R52); show-first follows', () => {
    const { options } = firstRunPrompt('S', 5);
    expect(options[0]!.value).toBe('acceptAll');
    expect(options[1]!.value).toBe('show');
    expect(options[1]!.label).toContain('Show them first');
    expect(options[1]!.label).toContain('accept (selectively) right after');
  });

  it('the bulk option states the count and that values have NOT been reviewed', () => {
    const { options } = firstRunPrompt('S', 113);
    const bulk = options.find((o) => o.value === 'acceptAll')!;
    expect(bulk.label).toContain('Accept ALL 113');
    expect(bulk.label).toContain('without reviewing them');
  });

  it('prompts speak the command vocabulary (accept) — no retired jargon', () => {
    const p = firstRunPrompt('S', 3);
    const all = [p.message, ...p.options.map((o) => o.label)].join(' ');
    // the retired word is assembled at runtime so this file itself stays free of it (R46)
    expect(all.toLowerCase()).not.toContain(['b', 'less'].join(''));
  });
});

describe('postAcceptNote (R52 — a partial accept is a SUCCESS for this run)', () => {
  it('partial accept (undeclared remain) → success + exit 0, remainder surfaces next check', () => {
    const note = postAcceptNote(112, 0);
    expect(note).toContain('accept succeeded');
    expect(note).toContain('112 unaccepted value(s) stay reported from the next check on');
    expect(note).toContain('exit 0 for this run');
  });

  it('everything accepted → CLEAN, exit 0', () => {
    expect(postAcceptNote(0, 0)).toBe('stack is now CLEAN — exit 0.');
  });

  it("declared/deleted drift remains → exit 1 (outside accept's reach), undeclared remainder also named", () => {
    const note = postAcceptNote(112, 2);
    expect(note).toContain('2 declared/deleted drift(s) remain un-addressed');
    expect(note).toContain('exit 1');
    expect(note).toContain('112 unaccepted value(s) also stay reported');
  });

  it('declared drift remains, nothing else → exit 1 without the undeclared clause', () => {
    const note = postAcceptNote(0, 1);
    expect(note).toContain('exit 1');
    expect(note).not.toContain('also stay reported');
  });
});

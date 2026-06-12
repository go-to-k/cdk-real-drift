import { describe, expect, it } from 'vite-plus/test';
import { firstRunPrompt, preDeployFindings } from '../src/commands/check.js';
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

  it('"show first" is the FIRST option (the safe default) and says accept is still possible after', () => {
    const { options } = firstRunPrompt('S', 5);
    expect(options[0]!.value).toBe('show');
    expect(options[0]!.label).toContain('Show them first');
    expect(options[0]!.label).toContain('accept (selectively) right after');
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

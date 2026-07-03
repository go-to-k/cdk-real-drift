import pc from 'picocolors';
import { describe, expect, it } from 'vite-plus/test';
import { report } from '../src/report/report.js';
import { makeStyle, style } from '../src/report/style.js';
import type { Finding } from '../src/types.js';

const ESC = '\x1b';
const SAMPLE = 'result: CLEAN — [tier] 1';

describe('style (R43 — colors only on a TTY)', () => {
  it('every helper is the identity when colors are disabled (piped / CI output is byte-identical)', () => {
    const s = makeStyle(pc.createColors(false));
    for (const fn of Object.values(s)) expect(fn(SAMPLE)).toBe(SAMPLE);
  });

  it('helpers emit ANSI when colors are enabled', () => {
    const s = makeStyle(pc.createColors(true));
    expect(s.clean(SAMPLE)).toContain(ESC);
    expect(s.clean(SAMPLE)).toContain(SAMPLE);
    expect(s.undeclaredTier('x')).toContain(`${ESC}[33m`); // yellow — distinct from declared/deleted red
    expect(s.driftTier('x')).toContain(`${ESC}[31m`); // red
  });

  it('note is the terminal DEFAULT foreground even with colors on — never dim, never a fixed color', () => {
    // Explanatory prose (tier notes, ↳ origin hints, the info: footer) is meant to be
    // READ. Dim (SGR 2) rendered it low-contrast / unreadable on dark terminals and wore
    // the same "don't read me" style as the picker chrome. note() must add NO SGR at all
    // so it inherits whatever the terminal theme uses for normal text.
    const s = makeStyle(pc.createColors(true));
    expect(s.note(SAMPLE)).toBe(SAMPLE); // identity — no ESC, no dim, no color
    expect(s.infoTier(SAMPLE)).toContain(`${ESC}[2m`); // UI chrome stays dim (deliberate)
  });

  it('result: is bolded so the conclusion still anchors the eye once info is no longer dim', () => {
    const s = makeStyle(pc.createColors(true));
    expect(s.resultLabel('result:')).toContain(`${ESC}[1m`); // bold
    expect(s.resultLabel('result:')).toContain('result:');
  });

  it('the module-level style is the identity in a non-TTY environment (this test run)', () => {
    // vitest workers run with piped stdio, so this asserts the real default path
    expect(style.drift(SAMPLE)).toBe(SAMPLE);
  });
});

describe('report output never carries ANSI when piped (R43)', () => {
  const findings: Finding[] = [
    {
      tier: 'declared',
      logicalId: 'B',
      resourceType: 'AWS::S3::Bucket',
      path: 'VersioningConfiguration',
      desired: { Status: 'Enabled' },
      actual: { Status: 'Suspended' },
    },
    {
      tier: 'undeclared',
      logicalId: 'B',
      resourceType: 'AWS::S3::Bucket',
      path: 'AccelerateConfiguration',
      actual: { AccelerationStatus: 'Enabled' },
    },
    {
      tier: 'skipped',
      logicalId: 'C',
      resourceType: 'Custom::X',
      path: '',
      note: 'custom resource',
    },
  ];

  it('text report: no ESC byte, and `^result:` stays greppable', () => {
    const lines: string[] = [];
    report(findings, 'S (us-east-1)', { log: (s) => lines.push(s) });
    const out = lines.join('\n');
    expect(out).not.toContain(ESC);
    expect(out).toMatch(/^result: 2 drift\(s\)/m);
  });

  it('--json report: no ESC byte ever', () => {
    const lines: string[] = [];
    report(findings, 'S (us-east-1)', { json: true, log: (s) => lines.push(s) });
    expect(lines.join('\n')).not.toContain(ESC);
  });
});

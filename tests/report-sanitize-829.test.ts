// #829: live-derived KEYS/IDS and note/hint lines in the TEXT report were printed RAW,
// unlike drift VALUES (JSON.stringify-escaped via j()/jPair()). A live map key / ELB
// attributeKey / array-delta identity id carrying `\r\nresult: CLEAN\x1b[2K` could inject a
// physical line that matches report.ts's documented `^result:` CI grep verdict (spoofing a
// CLEAN result), or use CR + ANSI to overwrite a real drift line on a TTY. The fix routes
// every such site through sanitizeForTerminal, which escapes C0 controls + DEL to `\xNN`.

import { describe, expect, it } from 'vite-plus/test';
import { formatFinding, sanitizeForTerminal } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

// A hostile live-derived key/id: a CR+LF to break onto a new physical line, a spoofed CI
// verdict, then an ANSI erase-line to hide the real one.
const PAYLOAD = 'owner\r\nresult: CLEAN\x1b[2K';

const base = (over: Partial<Finding>): Finding => ({
  tier: 'undeclared',
  logicalId: 'L',
  resourceType: 'AWS::X::Y',
  path: 'P',
  actual: 1,
  ...over,
});

// The three invariants a sanitized render must satisfy for a hostile field.
function assertNoInjection(rendered: string): void {
  expect(rendered).not.toMatch(/\r/); // no raw CR (would move the cursor / break a line)
  expect(rendered).not.toMatch(/\u001b/); // no raw ESC (no ANSI cursor/erase control)
  // no PHYSICAL line begins with `result:` — the CI grep verdict cannot be spoofed
  expect(rendered.split('\n').some((l) => /^result:/.test(l))).toBe(false);
  // the CR/ESC survive VISIBLY as escapes, so the drift is not silently dropped
  expect(rendered).toContain('\\x0d'); // CR -> \x0d
  expect(rendered).toContain('\\x1b'); // ESC -> \x1b
}

describe('#829 report control-char sanitization', () => {
  it('sanitizeForTerminal escapes C0 controls + DEL, leaves printable text', () => {
    expect(sanitizeForTerminal('owner\r\n\tx\x1b\x7f')).toBe('owner\\x0d\\x0a\\x09x\\x1b\\x7f');
    expect(sanitizeForTerminal('idle_timeout.timeout_seconds')).toBe(
      'idle_timeout.timeout_seconds'
    );
    expect(sanitizeForTerminal('日本語/héllo-世界')).toBe('日本語/héllo-世界'); // non-ASCII untouched
  });

  it('map-delta key (added key) cannot inject a verdict line', () => {
    // declared tier + both sides records → formatMapDelta; the payload is a live map KEY.
    const f = base({ tier: 'declared', desired: {}, actual: { [PAYLOAD]: 'v' } });
    assertNoInjection(formatFinding(f));
  });

  it('map-delta key (changed key) is sanitized', () => {
    const f = base({ tier: 'declared', desired: { [PAYLOAD]: 'a' }, actual: { [PAYLOAD]: 'b' } });
    assertNoInjection(formatFinding(f));
  });

  it('ELB attributeKey cannot inject a verdict line', () => {
    const f = base({ path: 'Attrs', attributeKey: PAYLOAD });
    assertNoInjection(formatFinding(f));
  });

  it('array-delta identity id (added) cannot inject a verdict line', () => {
    const f = base({
      arrayDelta: {
        identityField: 'PolicyName',
        added: [{ id: PAYLOAD, value: { x: 1 } }],
        removed: [],
        changed: [],
      },
    });
    assertNoInjection(formatFinding(f));
  });

  it('array-delta identity id (changed / removed) and identityField are sanitized', () => {
    const f = base({
      arrayDelta: {
        identityField: PAYLOAD,
        added: [],
        removed: [{ id: PAYLOAD, value: { x: 1 } }],
        changed: [{ id: PAYLOAD, recorded: { x: 1 }, actual: { x: 2 } }],
      },
    });
    assertNoInjection(formatFinding(f));
  });

  it('note line cannot inject a verdict line', () => {
    const f = base({ note: PAYLOAD });
    assertNoInjection(formatFinding(f));
  });

  it('hint line cannot inject a verdict line', () => {
    const f = base({ hint: PAYLOAD });
    assertNoInjection(formatFinding(f));
  });

  it('a benign key/attribute renders unchanged (no over-escaping)', () => {
    const f = base({
      path: 'Alb.LoadBalancerAttributes',
      attributeKey: 'idle_timeout.timeout_seconds',
    });
    const out = formatFinding(f);
    expect(out).toContain('[idle_timeout.timeout_seconds]');
    expect(out).not.toContain('\\x'); // nothing to escape
  });
});

// #1307: #1058 escaped bidi/zero-width controls in report KEYS/ids/notes via
// sanitizeForTerminal, but closed on the FALSE premise that VALUES were safe because they go
// through JSON.stringify. JSON.stringify escapes only C0 controls / quote / backslash / lone
// surrogates — it emits U+202E / U+200B / U+2066-2069 RAW inside the quoted string. So a
// live-controlled string VALUE still carried the spoof onto the terminal (an RLO visually
// reorders the `actual =` line; a zero-width char makes two different values render
// identically). Fix: post-process the stringified value in j()/jPair() with the same visible
// `\u{XXXX}` escape the key path uses — TEXT path only. The `--json` payload must stay
// byte-faithful (it is parsed, not rendered on a terminal).

import { describe, expect, it } from 'vite-plus/test';
import { buildStackJson, formatFinding, jPair } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

// The issue's evidence example: an SNS Topic DisplayName undeclared finding whose live VALUE
// carries a RIGHT-TO-LEFT OVERRIDE (U+202E) — which visually renders `desired=SAFE` inside an
// `actual =` line — and a trailing ZERO-WIDTH SPACE (U+200B).
const RLO = '‮'; // RIGHT-TO-LEFT OVERRIDE
const ZWSP = '​'; // ZERO-WIDTH SPACE
const HOSTILE_VALUE = `abc${RLO}desired=SAFE${ZWSP}`;

const snsFinding: Finding = {
  tier: 'undeclared',
  logicalId: 'Topic',
  resourceType: 'AWS::SNS::Topic',
  path: 'DisplayName',
  actual: HOSTILE_VALUE,
};

describe('#1307 report VALUE bidi/zero-width escaping (TEXT path)', () => {
  it('formatFinding escapes a raw U+202E / U+200B in an undeclared VALUE to \\u{...}', () => {
    const out = formatFinding(snsFinding);
    // the raw controls MUST NOT reach the terminal
    expect(out).not.toContain(RLO);
    expect(out).not.toContain(ZWSP);
    // they survive VISIBLY as the same escape form the key path (sanitizeForTerminal) uses
    expect(out).toContain('\\u{202E}');
    expect(out).toContain('\\u{200B}');
    // the escaped value is on the `actual =` line, benign text preserved
    expect(out).toContain('actual =');
    expect(out).toContain('abc\\u{202E}desired=SAFE\\u{200B}');
  });

  it('escapes bidi/zero-width in a declared desired/actual scalar PAIR (jPair path)', () => {
    const declared: Finding = {
      tier: 'declared',
      logicalId: 'Topic',
      resourceType: 'AWS::SNS::Topic',
      path: 'DisplayName',
      desired: 'safe',
      actual: HOSTILE_VALUE,
    };
    const out = formatFinding(declared);
    expect(out).not.toContain(RLO);
    expect(out).not.toContain(ZWSP);
    expect(out).toContain('\\u{202E}');
    expect(out).toContain('\\u{200B}');
  });

  it('jPair escapes bidi/zero-width in both the short and windowed (long-value) branches', () => {
    // short branch (both <= cap)
    const short = jPair('safe', HOSTILE_VALUE);
    expect(short.b).not.toContain(RLO);
    expect(short.b).not.toContain(ZWSP);
    expect(short.b).toContain('\\u{202E}');
    expect(short.b).toContain('\\u{200B}');

    // long branch (forces the windowing path): a long shared prefix + a hostile divergence
    const prefix = 'x'.repeat(300);
    const long = jPair(`${prefix}safe`, `${prefix}${RLO}evil${ZWSP}`);
    expect(long.b).not.toContain(RLO);
    expect(long.b).not.toContain(ZWSP);
    expect(long.b).toContain('\\u{202E}');
    expect(long.b).toContain('\\u{200B}');
  });

  it('a benign VALUE (CJK, emoji, printable) is NOT over-escaped', () => {
    const benign: Finding = {
      tier: 'undeclared',
      logicalId: 'Topic',
      resourceType: 'AWS::SNS::Topic',
      path: 'DisplayName',
      actual: '日本語-héllo \u{1F600}',
    };
    const out = formatFinding(benign);
    expect(out).toContain('日本語-héllo \u{1F600}');
    expect(out).not.toContain('\\u{'); // nothing to escape
  });

  it('the --json payload stays byte-faithful (raw controls preserved, NOT escaped)', () => {
    const { json } = buildStackJson([snsFinding], 'MyStack');
    const serialized = JSON.stringify(json);
    const parsed = JSON.parse(serialized) as {
      findings: { actual: string }[];
    };
    // the parsed value round-trips to the ORIGINAL raw string — no \u{...} visible-escape leaked in
    expect(parsed.findings[0].actual).toBe(HOSTILE_VALUE);
    expect(parsed.findings[0].actual).toContain(RLO);
    expect(parsed.findings[0].actual).toContain(ZWSP);
    // the visible key-path escape form must NOT appear in the JSON payload
    expect(serialized).not.toContain('\\u{202E}');
    expect(serialized).not.toContain('\\u{200B}');
  });
});

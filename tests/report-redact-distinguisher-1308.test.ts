import { describe, expect, it } from 'vite-plus/test';
import { maskPlaceholder, redactFinding } from '../src/report/redact.js';
import { buildStackJson } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

// #1308 — #1234's length-only mask (`<redacted:N chars>`) had two gaps:
//   (1) a rotated SAME-LENGTH secret rendered byte-identical on both the desired/actual
//       sides and across consecutive `--json` runs — zero distinguishing signal (a human
//       sees no change; a bot diffing two runs treats two DIFFERENT secrets as EQUAL and
//       suppresses the change on the machine channel).
//   (2) the mask is an in-band string with no `redacted: true` sibling in `--json`, so a
//       consumer can't tell a masked value from a literal live string.
// Fix: append a deterministic sha256 distinguisher to the placeholder, and stamp
// `redacted: true` on the masked --json finding.

// Two DIFFERENT secrets that happen to be the SAME LENGTH — the exact worst case #1234's
// length-only mask erased (both were `<redacted:36 chars>`).
const SECRET_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 36 chars
const SECRET_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'; // 36 chars

const lambdaEnvFinding = (value: string): Finding => ({
  tier: 'undeclared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment.Variables.API_TOKEN',
  actual: value,
  nested: true,
  freeFormKey: true,
});

describe('#1308 sha256 distinguisher for masked values', () => {
  it('two DIFFERENT same-length secrets produce DIFFERENT placeholders', () => {
    expect(SECRET_A.length).toBe(SECRET_B.length); // guard: the erased worst case
    const a = maskPlaceholder(SECRET_A);
    const b = maskPlaceholder(SECRET_B);
    // both carry the same length prefix (the length is not secret) …
    expect(a.startsWith('<redacted:36 chars:')).toBe(true);
    expect(b.startsWith('<redacted:36 chars:')).toBe(true);
    // … but the sha256 distinguisher differs, so a rotation is now visible (this is the
    // assertion that FAILS under the old length-only mask, where a === b).
    expect(a).not.toBe(b);
  });

  it('the SAME secret produces a STABLE placeholder across calls (deterministic across runs)', () => {
    // determinism is what lets a bot compare two consecutive `--json` runs correctly.
    expect(maskPlaceholder(SECRET_A)).toBe(maskPlaceholder(SECRET_A));
  });

  it('the placeholder never leaks the plaintext', () => {
    expect(maskPlaceholder(SECRET_A)).not.toContain(SECRET_A);
  });
});

describe('#1308 redacted:true json marker', () => {
  it('a redacted --json finding carries redacted: true (out-of-band marker)', () => {
    const { json } = buildStackJson([lambdaEnvFinding(SECRET_A)], 'stack (us-east-1)');
    const el = json.findings[0] as Finding & { redacted?: true };
    expect(el.redacted).toBe(true);
    // and the marker survives serialization (the machine channel a consumer reads)
    expect(JSON.stringify(json)).toContain('"redacted":true');
  });

  it('a NON-secret finding carries NO redacted marker', () => {
    const normal: Finding = {
      tier: 'declared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Timeout',
      desired: 30,
      actual: 900,
    };
    const { json } = buildStackJson([normal], 'stack (us-east-1)');
    const el = json.findings[0] as Finding & { redacted?: true };
    expect(el.redacted).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('"redacted"');
  });

  it('redactFinding sets redacted: true on the masked copy and leaves non-secret findings untouched', () => {
    const secret = redactFinding(lambdaEnvFinding(SECRET_A));
    expect(secret.redacted).toBe(true);
    const nonSecret = redactFinding({
      resourceType: 'AWS::Lambda::Function',
      path: 'Timeout',
      actual: 900,
    });
    // non-secret path returns the input unchanged (same reference, no marker)
    expect((nonSecret as { redacted?: true }).redacted).toBeUndefined();
  });
});

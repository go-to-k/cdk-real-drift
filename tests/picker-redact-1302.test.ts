import { describe, expect, it } from 'vite-plus/test';
import { changedRecordLabel, previewValue } from '../src/commands/stack-actions.js';

// #1302 — the record interactive multiselect row for a value CHANGED since record
// (`changedRecordLabel` / `previewValue`, src/commands/stack-actions.ts) prints straight to
// the terminal. It was missing the two hardening layers the report path applies to displayed
// VALUES:
//   1. NO REDACTION — a secret-bearing path (a Lambda/CodeBuild env var, the #798/#1234 masked
//      set) printed both the recorded and the rotated live secret in PLAINTEXT.
//   2. NO TERMINAL SANITIZING — a live STRING was returned verbatim, so a hostile value
//      carrying `\r` / ESC sequences (#829 class) was emitted raw inside the clack prompt.
// The fix routes every displayed value through `redactValue` (masking) AND `sanitizeForTerminal`
// (C0/ESC escaping), matching the report path. It is DISPLAY-ONLY — recording is unchanged.

const LAMBDA = 'AWS::Lambda::Function';
const SECRET_PATH = 'Environment.Variables.API_TOKEN';

describe('#1302 record-picker changed-value preview is redacted + terminal-sanitized', () => {
  it('redacts a secret-bearing path so neither the recorded nor the live plaintext prints', () => {
    const recorded = 'OLD_SECRET_abcdef';
    const live = 'NEW_SECRET_ghijkl';
    const label = changedRecordLabel(
      { logicalId: 'Fn', path: SECRET_PATH, value: live, resourceType: LAMBDA },
      { hasRecorded: true, recordedValue: recorded }
    );
    // The path/key name stays visible (it is not secret) but the plaintext values do not.
    expect(label).toContain('Fn.Environment.Variables.API_TOKEN');
    expect(label).not.toContain(recorded);
    expect(label).not.toContain(live);
    // Masked to the same `<redacted:N chars:…>` placeholder the report renderers use.
    expect(label).toMatch(/<redacted:\d+ chars:[0-9a-f]+>/);

    // previewValue on the same secret path masks the plaintext directly, too.
    const preview = previewValue(LAMBDA, SECRET_PATH, live);
    expect(preview).not.toContain(live);
    expect(preview).toMatch(/<redacted:\d+ chars:[0-9a-f]+>/);
  });

  it('sanitizes control chars (ESC + CR) out of a hostile live string value', () => {
    // A live value carrying an ANSI erase-line + CR — the #829 injection class. Use a
    // NON-secret path so the raw string reaches the sanitizer (a secret path would mask first).
    const hostile = 'plainvalue\x1b[2K\rspoof';
    const preview = previewValue('AWS::S3::Bucket', 'SomeProp', hostile);
    // No raw ESC (\x1b) or CR (\r) byte survives — they are escaped to a visible \xNN form.
    expect(preview).not.toContain('\x1b');
    expect(preview).not.toContain('\r');
    expect(preview).toContain('\\x1b');
    expect(preview).toContain('\\x0d');

    // Same guarantee through the full label builder.
    const label = changedRecordLabel(
      { logicalId: 'B', path: 'SomeProp', value: hostile, resourceType: 'AWS::S3::Bucket' },
      { hasRecorded: true, recordedValue: 'OLD' }
    );
    expect(label).not.toContain('\x1b');
    expect(label).not.toContain('\r');
  });

  it('leaves a normal (non-secret, control-free) value label shape unchanged', () => {
    const label = changedRecordLabel(
      { logicalId: 'A', path: 'P', value: 'NEW', resourceType: 'AWS::S3::Bucket' },
      { hasRecorded: true, recordedValue: 'OLD' }
    );
    expect(label).toBe('A.P (changed since record: OLD → NEW)');
    // A plain new-path row (no recorded value) is still a bare id.
    const plain = changedRecordLabel(
      { logicalId: 'A', path: 'P', value: 'NEW', resourceType: 'AWS::S3::Bucket' },
      { hasRecorded: false, recordedValue: undefined }
    );
    expect(plain).toBe('A.P');
  });
});

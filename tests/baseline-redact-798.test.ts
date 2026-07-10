import { describe, expect, it } from 'vite-plus/test';
import {
  baselineValueMatches,
  buildRecorded,
  type BaselineFile,
  splitRecordedByBaseline,
} from '../src/baseline/baseline-file.js';
import { isRedactedHashSentinel, redactedHashSentinel } from '../src/report/redact.js';
import type { Finding } from '../src/types.js';

// #798 (persistence half) — `record` must NOT write a live secret in plaintext into the
// git-committed baseline. A secret-bearing recorded value is stored as a HASH SENTINEL, and
// `baselineValueMatches` re-hashes the live side so change-detection survives (an unchanged
// secret stays recorded; a rotated one re-surfaces as drift) with no plaintext in the file.

const SECRET = 'super-secret-token-abcdef0123456789';
const ROTATED = 'rotated-secret-token-9876543210fedcba';

const lambdaEnvFinding = (value: unknown): Finding => ({
  tier: 'undeclared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment.Variables.API_TOKEN',
  actual: value,
  nested: true,
  freeFormKey: true,
});

const normalFinding = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  // a non-secret undeclared prop on the SAME resource type — must be recorded in plaintext
  path: 'MemorySize',
  actual: 512,
  nested: false,
});

describe('#798 buildRecorded hashes secret-bearing values, keeps others plaintext', () => {
  it('a Lambda env-var value is stored as a hash sentinel, not the plaintext', () => {
    const [entry] = buildRecorded([lambdaEnvFinding(SECRET)]);
    expect(entry).toBeDefined();
    expect(isRedactedHashSentinel(entry?.value)).toBe(true);
    // the plaintext secret appears NOWHERE in the serialized baseline entry
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).toContain('sha256:');
  });

  it('a non-secret value on the same resource type is recorded in plaintext (no over-redaction)', () => {
    const [entry] = buildRecorded([normalFinding()]);
    expect(entry?.value).toBe(512);
    expect(isRedactedHashSentinel(entry?.value)).toBe(false);
  });

  it('two DIFFERENT secrets hash to DIFFERENT sentinels (change is detectable)', () => {
    const a = buildRecorded([lambdaEnvFinding(SECRET)])[0]?.value;
    const b = buildRecorded([lambdaEnvFinding(ROTATED)])[0]?.value;
    expect(a).not.toEqual(b);
  });
});

describe('#798 baselineValueMatches compares secrets by hash (detection preserved)', () => {
  const rt = 'AWS::Lambda::Function';
  const sentinel = buildRecorded([lambdaEnvFinding(SECRET)])[0]?.value;

  it('sentinel vs the SAME live secret -> matches (record->check stays clean)', () => {
    expect(baselineValueMatches(sentinel, SECRET, rt)).toBe(true);
  });

  it('sentinel vs a ROTATED live secret -> does NOT match (re-surfaces as drift)', () => {
    expect(baselineValueMatches(sentinel, ROTATED, rt)).toBe(false);
  });

  it('reflexive across two built recorded sets (re-record of an unchanged secret)', () => {
    // splitRecordedByBaseline compares a freshly-built recorded set (also a sentinel) against
    // the prior baseline's sentinel — both sides hashed, must still read as unchanged.
    const prior: BaselineFile = {
      schemaVersion: 2,
      recorded: buildRecorded([lambdaEnvFinding(SECRET)]).map((e) => ({ ...e })),
    } as BaselineFile;
    const fresh = buildRecorded([lambdaEnvFinding(SECRET)]);
    const { unchanged, changed } = splitRecordedByBaseline(fresh, prior);
    expect(unchanged.length).toBe(1);
    expect(changed.length).toBe(0);
  });

  it('a rotated secret across two built recorded sets reads as CHANGED', () => {
    const prior: BaselineFile = {
      schemaVersion: 2,
      recorded: buildRecorded([lambdaEnvFinding(SECRET)]).map((e) => ({ ...e })),
    } as BaselineFile;
    const fresh = buildRecorded([lambdaEnvFinding(ROTATED)]);
    const { unchanged, changed } = splitRecordedByBaseline(fresh, prior);
    expect(unchanged.length).toBe(0);
    expect(changed.length).toBe(1);
  });

  it('backward-compatible: an OLD PLAINTEXT baseline of the same secret still matches', () => {
    // baselines written before this change hold the plaintext value — an unchanged secret must
    // not falsely re-surface (and must migrate to a sentinel without churn on re-record).
    expect(baselineValueMatches(SECRET, SECRET, rt)).toBe(true);
    expect(baselineValueMatches(SECRET, ROTATED, rt)).toBe(false);
  });

  it('a NON-secret sentinel-shaped baseline value still uses the sentinel hash path safely', () => {
    // Sanity: redactedHashSentinel/​isRedactedHashSentinel round-trip for a canonical value.
    const s = redactedHashSentinel({ a: 1, b: [2, 3] });
    expect(isRedactedHashSentinel(s)).toBe(true);
    // key order in the source object does not change the hash (deep key-sort is stable)
    expect(redactedHashSentinel({ b: [2, 3], a: 1 })).toEqual(s);
  });
});

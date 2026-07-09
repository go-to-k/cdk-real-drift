import { describe, expect, it } from 'vitest';
import { baselineValueMatches } from '../src/baseline/baseline-file.js';

// #807: `baselineValueMatches` must be REFLEXIVE — `baselineValueMatches(v, v)`
// has to be true for EVERY value, so a recorded value compared against the same
// live value converges. It was not, because only the baseline side was run through
// `canonicalizeForCompare` while the live side stayed raw. For a free-form-map ENTRY
// whose value is a JSON- or policy-shaped STRING (a Lambda env var, a Glue
// `Parameters` value, a Docker label), the recorded fragment lost its free-form
// ancestry, so canonicalization policy-parsed / JSON-minified / key-sorted the
// recorded side while the identical live side stayed a raw string → `deepEqual`
// false forever, and a re-record never converged. The fix canonicalizes BOTH sides.
describe('#807 baselineValueMatches reflexivity for free-form JSON/policy strings', () => {
  it('(a) a pretty-printed JSON string env-var value matches itself', () => {
    // e.g. a Lambda environment variable holding pretty-printed JSON config.
    const prettyJson = JSON.stringify(
      { featureFlags: { beta: true, alpha: false }, region: 'us-east-1' },
      null,
      2
    );
    expect(baselineValueMatches(prettyJson, prettyJson)).toBe(true);
  });

  it('(a2) a minified vs pretty form of the SAME JSON string matches', () => {
    // A baseline recorded in one whitespace form still matches a live read in
    // another whitespace / key order — the canonical (sorted, minified) form is equal.
    const pretty = JSON.stringify({ b: 2, a: 1 }, null, 2);
    const minified = '{"a":1,"b":2}';
    expect(baselineValueMatches(pretty, minified)).toBe(true);
  });

  it('(b) a policy-shaped string value matches itself', () => {
    // e.g. a resource-policy JSON stored as an opaque string fragment.
    const policyString = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    });
    expect(baselineValueMatches(policyString, policyString)).toBe(true);
  });

  it('(b2) a pretty-printed policy string matches its minified twin', () => {
    const doc = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    };
    const pretty = JSON.stringify(doc, null, 4);
    const minified = JSON.stringify(doc);
    expect(baselineValueMatches(pretty, minified)).toBe(true);
  });

  it('reflexive for a plain (non-JSON) string too', () => {
    const plain = 'a plain env-var value, not JSON at all';
    expect(baselineValueMatches(plain, plain)).toBe(true);
  });

  it('reflexive for an object value (regression: object entries still match)', () => {
    const obj = { A: '1', B: '2' };
    expect(baselineValueMatches(obj, obj)).toBe(true);
  });

  // (c) regression: a genuinely different value must STILL be detected as changed —
  // canonicalizing both sides restores reflexivity WITHOUT weakening change detection.
  it('(c) a genuinely different JSON string value still returns false', () => {
    const recorded = JSON.stringify({ enabled: true }, null, 2);
    const changed = JSON.stringify({ enabled: false }, null, 2);
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });

  it('(c2) a policy string with a changed Action still returns false', () => {
    const recorded = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    });
    const changed = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }],
    });
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });

  it('(c3) a changed plain string still returns false', () => {
    expect(baselineValueMatches('old value', 'new value')).toBe(false);
  });
});

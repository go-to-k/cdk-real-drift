import { describe, it, expect } from 'vitest';
import { canonicalizePolicy, normalizePoliciesDeep } from '../src/normalize/policy-canonical.js';
import { deepEqual } from '../src/diff/drift-calculator.js';

describe('policy canonicalization', () => {
  it('fills default Version and unifies scalar vs array Action', () => {
    const a = canonicalizePolicy({ Statement: [{ Effect: 'Allow', Action: 's3:Get' }] });
    const b = canonicalizePolicy({ Version: '2012-10-17', Statement: [{ Action: ['s3:Get'], Effect: 'Allow' }] });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('is order-independent across statements and within Action arrays', () => {
    const a = canonicalizePolicy({ Statement: [{ Effect: 'Allow', Action: ['b', 'a'] }, { Effect: 'Deny', Action: 'x' }] });
    const b = canonicalizePolicy({ Statement: [{ Effect: 'Deny', Action: ['x'] }, { Effect: 'Allow', Action: ['a', 'b'] }] });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('decodes a URL-encoded JSON policy string to the same canonical form', () => {
    const obj = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] };
    const encoded = encodeURIComponent(JSON.stringify(obj));
    expect(deepEqual(normalizePoliciesDeep(encoded), canonicalizePolicy(obj))).toBe(true);
  });

  it('normalizePoliciesDeep replaces nested policy docs, leaves non-policy data', () => {
    const out = normalizePoliciesDeep({ Policies: [{ PolicyName: 'p', PolicyDocument: { Statement: [{ Action: 'x', Effect: 'Allow' }] } }], Other: 5 }) as any;
    expect(out.Other).toBe(5);
    expect(out.Policies[0].PolicyDocument.Version).toBe('2012-10-17');
  });

  it('leaves a plain non-policy string untouched', () => {
    expect(normalizePoliciesDeep('just a string')).toBe('just a string');
  });

  it('treats account id and its root ARN as equal principals', () => {
    const a = canonicalizePolicy({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: '123456789012' } }] });
    const b = canonicalizePolicy({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: 'arn:aws:iam::123456789012:root' } }] });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('canonicalizes embedded JSON-text strings (pretty vs minified)', () => {
    const pretty = '{\n  "rules": [ { "a": 1, "b": 2 } ]\n}';
    const mini = '{"rules":[{"b":2,"a":1}]}';
    expect(normalizePoliciesDeep(pretty)).toBe(normalizePoliciesDeep(mini));
  });
});

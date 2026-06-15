import { describe, expect, it } from 'vite-plus/test';
import { deepEqual } from '../src/diff/drift-calculator.js';
import {
  canonicalizePolicy,
  normalizePoliciesDeep,
  rewriteOaiPrincipalsDeep,
} from '../src/normalize/policy-canonical.js';

describe('policy canonicalization', () => {
  it('unifies scalar vs array Action; does not fabricate Version when absent', () => {
    const a = canonicalizePolicy({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:Get' }],
    });
    const b = canonicalizePolicy({
      Version: '2012-10-17',
      Statement: [{ Action: ['s3:Get'], Effect: 'Allow' }],
    });
    expect(deepEqual(a, b)).toBe(true);
    expect(canonicalizePolicy({ Statement: [] })).not.toHaveProperty('Version');
  });

  it('is order-independent across statements and within Action arrays', () => {
    const a = canonicalizePolicy({
      Statement: [
        { Effect: 'Allow', Action: ['b', 'a'] },
        { Effect: 'Deny', Action: 'x' },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        { Effect: 'Deny', Action: ['x'] },
        { Effect: 'Allow', Action: ['a', 'b'] },
      ],
    });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('decodes a URL-encoded JSON policy string to the same canonical form', () => {
    const obj = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal: { Service: 'lambda.amazonaws.com' },
        },
      ],
    };
    const encoded = encodeURIComponent(JSON.stringify(obj));
    expect(deepEqual(normalizePoliciesDeep(encoded), canonicalizePolicy(obj))).toBe(true);
  });

  it('normalizePoliciesDeep replaces nested policy docs, leaves non-policy data', () => {
    const out = normalizePoliciesDeep({
      Policies: [
        { PolicyName: 'p', PolicyDocument: { Statement: [{ Action: 'x', Effect: 'Allow' }] } },
      ],
      Other: 5,
    }) as any;
    expect(out.Other).toBe(5);
    // policy doc was canonicalized (Action scalar -> sorted array), non-policy data untouched
    expect(out.Policies[0].PolicyDocument.Statement[0].Action).toEqual(['x']);
  });

  it('leaves a plain non-policy string untouched', () => {
    expect(normalizePoliciesDeep('just a string')).toBe('just a string');
  });

  it('treats account id and its root ARN as equal principals', () => {
    const a = canonicalizePolicy({
      Statement: [
        { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: '123456789012' } },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal: { AWS: 'arn:aws:iam::123456789012:root' },
        },
      ],
    });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('canonicalizes embedded JSON-text strings (pretty vs minified)', () => {
    const pretty = '{\n  "rules": [ { "a": 1, "b": 2 } ]\n}';
    const mini = '{"rules":[{"b":2,"a":1}]}';
    expect(normalizePoliciesDeep(pretty)).toBe(normalizePoliciesDeep(mini));
  });

  // Condition canonicalization: an IAM condition key's value is an unordered SET
  // of strings written as a scalar or an array; IAM treats both forms identically
  // and AWS may store/return either, in any order. Without canonicalization a
  // reordered multi-value condition, or a scalar-declared single value AWS stores
  // as a one-element array, fires a false declared drift.
  it('treats a reordered multi-value Condition as equal', () => {
    const a = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceArn': ['arnA', 'arnB'] } },
        },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceArn': ['arnB', 'arnA'] } },
        },
      ],
    });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('treats a scalar Condition value and its one-element-array form as equal', () => {
    const a = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
        },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceAccount': ['123456789012'] } },
        },
      ],
    });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('is order-independent across Condition operator keys', () => {
    const a = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: {
            StringEquals: { 'aws:x': '1' },
            Bool: { 'aws:SecureTransport': 'true' },
          },
        },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: {
            Bool: { 'aws:SecureTransport': 'true' },
            StringEquals: { 'aws:x': '1' },
          },
        },
      ],
    });
    expect(deepEqual(a, b)).toBe(true);
  });

  it('still reports a GENUINE Condition value change (no over-suppression)', () => {
    const a = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceArn': ['arnA', 'arnB'] } },
        },
      ],
    });
    const b = canonicalizePolicy({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceArn': ['arnA', 'arnC'] } },
        },
      ],
    });
    expect(deepEqual(a, b)).toBe(false);
  });

  it('leaves a non-object Condition value untouched (defensive)', () => {
    const out = canonicalizePolicy({
      Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*', Condition: 'weird' }],
    });
    expect((out.Statement as any[])[0].Condition).toBe('weird');
  });
});

describe('CloudFront OAI principal reconciliation (rewriteOaiPrincipalsDeep)', () => {
  const OAI_ID = 'EM4A89W3GHI3';
  const CANON =
    '9f136d368cf2e7a1231ec86b0e9fba1753e7182eda536b6294f93d5667ce29f71f5d58bb774dbb93d4a89e7b2c1a3c4e';
  const map = { [OAI_ID]: CANON };
  const userArn = `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ${OAI_ID}`;

  // the declared (CDK grantRead) side and the live (GetBucketPolicy) side, the exact
  // two forms the real-AWS probe produced for the same OAI grant
  const declaredDoc = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Principal: { CanonicalUser: CANON } }],
  };
  const liveDoc = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Principal: { AWS: userArn } }],
  };

  it('reconciles the cloudfront:user ARN form to the declared CanonicalUser form', () => {
    const live = canonicalizePolicy(
      rewriteOaiPrincipalsDeep(liveDoc, map) as Record<string, unknown>
    );
    const declared = canonicalizePolicy(
      rewriteOaiPrincipalsDeep(declaredDoc, map) as Record<string, unknown>
    );
    expect(deepEqual(live, declared)).toBe(true);
  });

  it('is a no-op when the OAI id is not in the map (no false equivalence)', () => {
    const live = canonicalizePolicy(
      rewriteOaiPrincipalsDeep(liveDoc, {}) as Record<string, unknown>
    );
    const declared = canonicalizePolicy(declaredDoc);
    // unresolved → forms still differ, so a real repoint to an unknown OAI is NOT hidden
    expect(deepEqual(live, declared)).toBe(false);
  });

  it('does NOT equate two DIFFERENT OAIs', () => {
    const otherArn = 'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity OTHEROAI123';
    const otherLive = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Principal: { AWS: otherArn } }],
    };
    const live = canonicalizePolicy(
      rewriteOaiPrincipalsDeep(otherLive, map) as Record<string, unknown>
    );
    const declared = canonicalizePolicy(declaredDoc);
    expect(deepEqual(live, declared)).toBe(false);
  });

  it('splits a mixed AWS principal, keeping non-OAI ARNs and hoisting the OAI to CanonicalUser', () => {
    const out = rewriteOaiPrincipalsDeep(
      {
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: { AWS: ['arn:aws:iam::123456789012:role/r', userArn] },
          },
        ],
      },
      map
    ) as any;
    const p = out.Statement[0].Principal;
    expect(p.AWS).toBe('arn:aws:iam::123456789012:role/r');
    expect(p.CanonicalUser).toBe(CANON);
  });

  it('leaves a non-OAI policy entirely untouched', () => {
    const doc = {
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal: { Service: 'lambda.amazonaws.com' },
        },
      ],
    };
    expect(rewriteOaiPrincipalsDeep(doc, map)).toEqual(doc);
  });
});

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

  it('preserves a top-level Id (and other top-level keys); policies differing only in Id are NOT equal', () => {
    const stmt = [{ Effect: 'Allow', Action: 's3:Get', Resource: '*' }];
    const a = canonicalizePolicy({ Version: '2012-10-17', Id: 'A', Statement: stmt });
    const b = canonicalizePolicy({ Version: '2012-10-17', Id: 'B', Statement: stmt });
    expect(a.Id).toBe('A');
    expect(deepEqual(a, b)).toBe(false); // an out-of-band doc-level Id change is no longer hidden
    // same Id with a reordered statement still canon-equal (canonicalization still applies)
    const c = canonicalizePolicy({
      Version: '2012-10-17',
      Id: 'A',
      Statement: [{ Effect: 'Allow', Resource: '*', Action: 's3:Get' }],
    });
    expect(deepEqual(a, c)).toBe(true);
  });

  it('does NOT mangle a non-policy value under a key literally named Statement', () => {
    // a free-form field whose Statement is a STRING is not an IAM policy — pass through
    expect(normalizePoliciesDeep({ Statement: 'hello', Other: [3, 1, 2] })).toEqual({
      Statement: 'hello',
      Other: [3, 1, 2],
    });
    // a Statement array whose elements lack `Effect` is not a policy — untouched
    expect(normalizePoliciesDeep({ Statement: [{ Foo: 1 }] })).toEqual({ Statement: [{ Foo: 1 }] });
    // a REAL policy (statements carry Effect) IS still canonicalized (Action sorted)
    const real = normalizePoliciesDeep({
      Statement: [{ Effect: 'Allow', Action: ['b', 'a'], Resource: '*' }],
    }) as { Statement: { Action: unknown }[] };
    expect(real.Statement[0].Action).toEqual(['a', 'b']);
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

  describe('free-form user-map values are opaque (WAVE21 — R69 extended past cc-strip)', () => {
    const reordered = (parent: string) => ({
      a: normalizePoliciesDeep({ [parent]: { CONFIG: '{"region":"us-east-1","mode":"a"}' } }),
      b: normalizePoliciesDeep({ [parent]: { CONFIG: '{"mode":"a","region":"us-east-1"}' } }),
    });

    it('a JSON-string value under Variables is NOT re-serialized (a real key-order edit stays visible)', () => {
      const { a, b } = reordered('Variables');
      expect(deepEqual(a, b)).toBe(false);
    });

    for (const parent of ['Parameters', 'DefaultArguments', 'DockerLabels', 'Labels', 'Tags']) {
      it(`a JSON-string value under ${parent} is opaque too`, () => {
        const { a, b } = reordered(parent);
        expect(deepEqual(a, b)).toBe(false);
      });
    }

    it('a policy-SHAPED user value under a free-form map is NOT policy-canonicalized', () => {
      const s1 = '{"Statement":[{"Effect":"Allow","Action":"a"},{"Effect":"Allow","Action":"b"}]}';
      const s2 = '{"Statement":[{"Effect":"Allow","Action":"b"},{"Effect":"Allow","Action":"a"}]}';
      expect(
        deepEqual(
          normalizePoliciesDeep({ Variables: { P: s1 } }),
          normalizePoliciesDeep({ Variables: { P: s2 } })
        )
      ).toBe(false);
    });

    it('a REAL policy NOT under a free-form map still canonicalizes (no regression)', () => {
      const r1 = {
        PolicyDocument: {
          Statement: [
            { Effect: 'Allow', Action: 'a' },
            { Effect: 'Allow', Action: 'b' },
          ],
        },
      };
      const r2 = {
        PolicyDocument: {
          Statement: [
            { Effect: 'Allow', Action: 'b' },
            { Effect: 'Allow', Action: 'a' },
          ],
        },
      };
      expect(deepEqual(normalizePoliciesDeep(r1), normalizePoliciesDeep(r2))).toBe(true);
    });

    it('a genuine value change under a free-form map still differs', () => {
      expect(
        deepEqual(
          normalizePoliciesDeep({ Variables: { X: '{"a":1}' } }),
          normalizePoliciesDeep({ Variables: { X: '{"a":2}' } })
        )
      ).toBe(false);
    });
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

describe('policy canonicalization: AWS-injected Sid + vended-log-delivery statement', () => {
  const stmt = (extra: Record<string, unknown> = {}) => ({
    Effect: 'Allow',
    Action: 's3:PutObject',
    Principal: { Service: 'delivery.logs.amazonaws.com' },
    Resource: 'arn:aws:s3:::bucket/*',
    ...extra,
  });

  it('a statement declared without a Sid equals the same statement AWS returns with a numeric Sid', () => {
    const declared = canonicalizePolicy({ Statement: [stmt()] });
    const live = canonicalizePolicy({ Statement: [stmt({ Sid: '1' })] });
    expect(deepEqual(declared, live)).toBe(true);
    // a MEANINGFUL (non-numeric) Sid is preserved, so a real Sid change still differs
    const labeled = canonicalizePolicy({ Statement: [stmt({ Sid: 'AllowLogDelivery' })] });
    expect(deepEqual(declared, labeled)).toBe(false);
  });

  it("AWS's vended-log-delivery statement (AWSLogDelivery* + delivery.logs principal) is dropped", () => {
    const withVended = canonicalizePolicy({
      Statement: [
        stmt({ Sid: '1' }),
        stmt({
          Sid: 'AWSLogDeliveryWrite1',
          Resource: 'arn:aws:s3:::bucket/AWSLogs/1/CloudFront/*',
        }),
      ],
    });
    const declaredOnly = canonicalizePolicy({ Statement: [stmt()] });
    expect(deepEqual(withVended, declaredOnly)).toBe(true);
  });

  it('does NOT drop a user statement that uses the delivery-logs principal WITHOUT an AWSLogDelivery Sid', () => {
    const doc = canonicalizePolicy({ Statement: [stmt({ Sid: 'MyOwnRule' })] });
    expect(Array.isArray(doc.Statement) ? doc.Statement.length : 0).toBe(1);
  });
});

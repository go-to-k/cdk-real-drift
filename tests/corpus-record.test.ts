import { describe, expect, it } from 'vite-plus/test';
import {
  buildCorpusCase,
  corpusFileName,
  decodeUnresolved,
  encodeUnresolved,
  reviveSchema,
  sanitizeAccountId,
  UNRESOLVED_SENTINEL,
} from '../src/corpus/record.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

describe('corpus recording (R63)', () => {
  it('sanitizeAccountId replaces the account id inside any nested string', () => {
    const v = {
      arn: 'arn:aws:iam::123456789012:role/x',
      list: ['123456789012', { deep: 'a 123456789012 b' }],
      n: 5,
    };
    expect(sanitizeAccountId(v, '123456789012')).toEqual({
      arn: 'arn:aws:iam::111111111111:role/x',
      list: ['111111111111', { deep: 'a 111111111111 b' }],
      n: 5,
    });
  });

  it('sanitizeAccountId with an empty account id is the identity', () => {
    expect(sanitizeAccountId({ a: '1' }, '')).toEqual({ a: '1' });
  });

  it('encode/decode round-trips the UNRESOLVED symbol through JSON', () => {
    const declared = { Role: UNRESOLVED, Nested: { Arn: [UNRESOLVED, 'x'] } };
    const encoded = encodeUnresolved(declared);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual({
      Role: UNRESOLVED_SENTINEL,
      Nested: { Arn: [UNRESOLVED_SENTINEL, 'x'] },
    });
    expect(decodeUnresolved(encoded)).toEqual(declared);
  });

  it('corpusFileName flattens :: and appends the logical id', () => {
    expect(corpusFileName('AWS::S3::Bucket', 'MyBucket')).toBe('AWS__S3__Bucket.MyBucket.json');
  });

  it('buildCorpusCase serializes schema sets, sanitizes, and reviveSchema restores them', () => {
    const resource: DesiredResource = {
      logicalId: 'R',
      resourceType: 'AWS::X::Y',
      physicalId: 'arn:aws:x:us-east-1:123456789012:y/r',
      declared: { A: 'arn:aws:iam::123456789012:role/r' },
    };
    const schema: SchemaInfo = {
      readOnly: new Set(['Arn']),
      writeOnly: new Set(),
      createOnly: new Set(),
      readOnlyPaths: ['Arn'],
      writeOnlyPaths: [],
      createOnlyPaths: [],
      defaults: {},
      defaultPaths: {},
      unorderedScalarPaths: ['Tags'],
    };
    const findings: Finding[] = [
      {
        tier: 'undeclared',
        logicalId: 'R',
        resourceType: 'AWS::X::Y',
        path: 'P',
        actual: 'arn:aws:x:us-east-1:123456789012:y/p',
        physicalId: 'arn:aws:x:us-east-1:123456789012:y/r',
      },
    ];
    const c = buildCorpusCase(
      resource,
      { A: 'arn:aws:iam::123456789012:role/r' },
      schema,
      { accountId: '123456789012', region: 'us-east-1', kmsAliasTargets: {}, oaiCanonicalIds: {} },
      findings
    );
    // sanitized EVERYWHERE, consistently (inputs, opts, and expected findings)
    expect(c.resource.physicalId).toBe('arn:aws:x:us-east-1:111111111111:y/r');
    expect(c.opts.accountId).toBe('111111111111');
    expect(c.expected[0]!.actual).toBe('arn:aws:x:us-east-1:111111111111:y/p');
    // schema sets serialized as sorted arrays; revive restores Sets
    expect(c.schema.readOnly).toEqual(['Arn']);
    expect(reviveSchema(c.schema).readOnly.has('Arn')).toBe(true);
    // insertionOrder:false scalar paths round-trip through serialize + revive
    expect(c.schema.unorderedScalarPaths).toEqual(['Tags']);
    expect(reviveSchema(c.schema).unorderedScalarPaths).toEqual(['Tags']);
    // JSON-safe end to end
    expect(() => JSON.stringify(c)).not.toThrow();
  });
});

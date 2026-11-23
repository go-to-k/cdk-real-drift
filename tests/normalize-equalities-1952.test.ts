// #1952 — normalization rules that equated values AWS treats differently, driven through
// classifyResource so each fence covers the whole compare pipeline (both sides'
// canonicalization, the order-significant tables, the KMS-alias call site), not just the
// helper. Each case is a real change that used to read clean.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, KMS_ALIAS_UNRESOLVED_NOTE } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const schema = (unorderedObjectArrayPaths: string[] = []): SchemaInfo => ({
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
  unorderedObjectArrayPaths,
});

const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

const drift = (fs: Finding[]) =>
  fs.filter((f) => f.tier === 'declared' || f.tier === 'undeclared').map((f) => f.path);

describe('#1952 item 6: Glue columns are positional', () => {
  // The registry schema marks these insertionOrder:false (a lie for positional SerDes).
  const glueSchema = schema([
    'TableInput.StorageDescriptor.Columns',
    'TableInput.PartitionKeys',
    'TableInput.StorageDescriptor.SortColumns',
  ]);
  const cols = (...names: string[]) => names.map((Name) => ({ Name, Type: 'string' }));
  const table = (columns: string[], partitionKeys: string[]) => ({
    CatalogId: '111122223333',
    DatabaseName: 'db',
    TableInput: {
      Name: 't',
      PartitionKeys: cols(...partitionKeys),
      StorageDescriptor: { Columns: cols(...columns), Location: 's3://b/t/' },
    },
  });

  it('the same order is clean', () => {
    const v = table(['a', 'b', 'c'], ['dt', 'hr']);
    expect(drift(classifyResource(mk('AWS::Glue::Table', v), v, glueSchema))).toEqual([]);
  });

  it('a column reorder (update-table) is drift', () => {
    const f = classifyResource(
      mk('AWS::Glue::Table', table(['a', 'b', 'c'], ['dt', 'hr'])),
      table(['b', 'a', 'c'], ['dt', 'hr']),
      glueSchema
    );
    expect(drift(f).length).toBeGreaterThan(0);
    expect(drift(f).every((p) => p.startsWith('TableInput'))).toBe(true);
  });

  it('a partition-key reorder is drift', () => {
    const f = classifyResource(
      mk('AWS::Glue::Table', table(['a', 'b'], ['dt', 'hr'])),
      table(['a', 'b'], ['hr', 'dt']),
      glueSchema
    );
    expect(drift(f).length).toBeGreaterThan(0);
  });

  it('a Glue::Partition column reorder is drift (identity sort no longer applies)', () => {
    const part = (names: string[]) => ({
      CatalogId: '111122223333',
      DatabaseName: 'db',
      TableName: 't',
      PartitionInput: { Values: ['2026'], StorageDescriptor: { Columns: cols(...names) } },
    });
    const f = classifyResource(
      mk('AWS::Glue::Partition', part(['a', 'b'])),
      part(['b', 'a']),
      schema()
    );
    expect(drift(f).length).toBeGreaterThan(0);
  });
});

describe('#1952 item 2: a DECLARED AWSLogDelivery statement is compared', () => {
  const guard = { StringEquals: { 'aws:SourceAccount': '111122223333' } };
  const userStmt = {
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Action: 's3:*',
    Resource: 'arn:aws:s3:::b/*',
    Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  };
  const vended = {
    Sid: 'AWSLogDeliveryWrite',
    Effect: 'Allow',
    Principal: { Service: 'delivery.logs.amazonaws.com' },
    Action: 's3:PutObject',
    Resource: 'arn:aws:s3:::b/AWSLogs/111122223333/*',
    Condition: guard,
  };
  const bp = (...Statement: unknown[]) => ({
    Bucket: 'b',
    PolicyDocument: { Version: '2012-10-17', Statement },
  });

  it('unchanged is clean', () => {
    const v = bp(userStmt, vended);
    expect(drift(classifyResource(mk('AWS::S3::BucketPolicy', v), v, schema()))).toEqual([]);
  });

  it('deleted out of band is drift', () => {
    const f = classifyResource(
      mk('AWS::S3::BucketPolicy', bp(userStmt, vended)),
      bp(userStmt),
      schema()
    );
    expect(drift(f)).toContain('PolicyDocument.Statement');
  });

  it('its confused-deputy condition stripped out of band is drift', () => {
    const { Condition: _dropped, ...unguarded } = vended;
    const f = classifyResource(
      mk('AWS::S3::BucketPolicy', bp(userStmt, vended)),
      bp(userStmt, unguarded),
      schema()
    );
    expect(drift(f).length).toBeGreaterThan(0);
  });

  it('a live-only vended statement (not declared) is still subtracted', () => {
    const f = classifyResource(
      mk('AWS::S3::BucketPolicy', bp(userStmt)),
      bp(userStmt, vended),
      schema()
    );
    expect(drift(f)).toEqual([]);
  });
});

describe('#1952 item 1: an absent Version is 2008-10-17', () => {
  const stmt = {
    Effect: 'Allow',
    Principal: { AWS: '*' },
    Action: 'sqs:SendMessage',
    Resource: '*',
  };
  const qp = (doc: Record<string, unknown>) => ({ Queues: ['https://q'], PolicyDocument: doc });

  it('a Version-less template against a live "2012-10-17" is drift', () => {
    const f = classifyResource(
      mk('AWS::SQS::QueuePolicy', qp({ Statement: [stmt] })),
      qp({ Version: '2012-10-17', Statement: [stmt] }),
      schema()
    );
    expect(drift(f)).toContain('PolicyDocument.Version');
  });

  it('a Version-less template against a live literal "2008-10-17" is clean', () => {
    const f = classifyResource(
      mk('AWS::SQS::QueuePolicy', qp({ Statement: [stmt] })),
      qp({ Version: '2008-10-17', Statement: [stmt] }),
      schema()
    );
    expect(drift(f)).toEqual([]);
  });
});

describe('#1952 item 5: an unresolvable managed KMS alias is not comparable', () => {
  const keyId = '9ee8feba-ae18-445a-bcab-306f7748fb6c';
  const keyArn = `arn:aws:kms:us-east-1:111122223333:key/${keyId}`;
  const declared = { QueueName: 'q', KmsMasterKeyId: 'alias/aws/sqs' };
  const live = { QueueName: 'q', KmsMasterKeyId: keyArn };

  it('reports a readGap, never "equal", when the alias is unresolved', () => {
    const f = classifyResource(mk('AWS::SQS::Queue', declared), live, schema(), {
      kmsAliasTargets: {},
    });
    expect(drift(f)).toEqual([]);
    expect(f).toContainEqual(
      expect.objectContaining({
        tier: 'readGap',
        path: 'KmsMasterKeyId',
        note: KMS_ALIAS_UNRESOLVED_NOTE,
      })
    );
  });

  it('is clean when the alias resolves to the live key', () => {
    const f = classifyResource(mk('AWS::SQS::Queue', declared), live, schema(), {
      kmsAliasTargets: { 'alias/aws/sqs': keyId },
    });
    expect(f.filter((x) => x.path === 'KmsMasterKeyId')).toEqual([]);
  });

  it('is drift when the alias resolves to a different key', () => {
    const f = classifyResource(mk('AWS::SQS::Queue', declared), live, schema(), {
      kmsAliasTargets: { 'alias/aws/sqs': '00000000-1111-2222-3333-444444444444' },
    });
    expect(drift(f)).toContain('KmsMasterKeyId');
  });
});

// #1293 — AWS::DMS::Endpoint per-engine `*Settings` blobs (S3Settings/KinesisSettings/…) are
// NOT projected by readDmsEndpoint (the SDK key-casing drifts from the CFn schema and AWS
// default-fills them, so a passthrough would false-flag). Without the readGap denylist, a
// declared `S3Settings` (a REQUIRED, non-empty object for an S3 endpoint) hits classify's
// removed-collection branch as `[CFn-Declared Drift] S3Settings desired={…} actual=undefined`
// on essentially every S3/Kinesis/Mongo/… endpoint, survives record, and revert offers a
// bogus whole-property add. READGAP_COLLECTION_PATHS['AWS::DMS::Endpoint'] makes it an honest
// counted readGap instead.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { READGAP_COLLECTION_PATHS } from '../src/normalize/noise.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';

// No writeOnly on the *Settings, so they survive schema-strip into the declared model — the
// condition under which the removed-collection branch would fire.
const schema: SchemaInfo = {
  readOnly: new Set(['Id']),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: ['Id'],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Endpoint',
  resourceType: 'AWS::DMS::Endpoint',
  physicalId: 'arn:aws:dms:us-east-1:123456789012:endpoint:ABCDEF0123456789',
  declared,
});

describe('#1293 DMS::Endpoint *Settings readGap denylist', () => {
  it('a declared S3Settings absent from the live read stays readGap, not declared drift', () => {
    const findings = classifyResource(
      mk({
        EndpointType: 'target',
        EngineName: 's3',
        S3Settings: {
          BucketName: 'my-bucket',
          ServiceAccessRoleArn: 'arn:aws:iam::123456789012:role/dms',
        },
      }),
      // the reader projects only the scalars; S3Settings is never in the live model
      { EndpointType: 'target', EngineName: 's3' },
      schema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'S3Settings')).toBe(false);
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'S3Settings')).toBe(true);
  });

  it('a declared KinesisSettings likewise stays readGap, not declared drift', () => {
    const findings = classifyResource(
      mk({
        EndpointType: 'target',
        EngineName: 'kinesis',
        KinesisSettings: {
          StreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/s',
          MessageFormat: 'json',
        },
      }),
      { EndpointType: 'target', EngineName: 'kinesis' },
      schema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'KinesisSettings')).toBe(false);
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'KinesisSettings')).toBe(true);
  });

  it('denylist covers the full 17-key AWS::DMS::Endpoint *Settings set', () => {
    const keys = READGAP_COLLECTION_PATHS['AWS::DMS::Endpoint'];
    expect(keys?.size).toBe(17);
    for (const k of [
      'DocDbSettings',
      'DynamoDbSettings',
      'ElasticsearchSettings',
      'GcpMySQLSettings',
      'IbmDb2Settings',
      'KafkaSettings',
      'KinesisSettings',
      'MicrosoftSqlServerSettings',
      'MongoDbSettings',
      'MySqlSettings',
      'NeptuneSettings',
      'OracleSettings',
      'PostgreSqlSettings',
      'RedisSettings',
      'RedshiftSettings',
      'S3Settings',
      'SybaseSettings',
    ]) {
      expect(keys?.has(k)).toBe(true);
    }
  });

  it('a real out-of-band change to a projected SCALAR is still detected (no over-suppression)', () => {
    const findings = classifyResource(
      mk({ EndpointType: 'target', EngineName: 's3', ServerName: 'declared.example.com' }),
      { EndpointType: 'target', EngineName: 's3', ServerName: 'changed.example.com' },
      schema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'ServerName')).toBe(true);
  });
});

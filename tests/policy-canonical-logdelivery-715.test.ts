import { describe, expect, it } from 'vite-plus/test';
import { canonicalizePolicy } from '../src/normalize/policy-canonical.js';

// #715: the AWSLogDelivery statement subtraction was content-blind (matched on ONLY the
// Sid prefix + delivery-logs principal, ignoring Action/Resource/Condition). A rogue
// statement carrying the AWSLogDelivery Sid + principal but ARBITRARY grants (Action:
// s3:*) was silently subtracted on both sides → a policy widening read CLEAN (invisible).
// The subtraction is now equality-gated to the documented safe Action shape.

function stmtCount(doc: Record<string, unknown>): number {
  return Array.isArray(doc.Statement) ? doc.Statement.length : 0;
}

describe('#715: AWSLogDelivery subtraction is content-gated (Action must be safe)', () => {
  const deliveryPrincipal = { Service: 'delivery.logs.amazonaws.com' } as const;

  it('does NOT drop a rogue AWSLogDelivery statement granting a broader Action (s3:*)', () => {
    // The rogue statement from the issue: AWSLogDelivery* Sid + delivery-logs principal,
    // but a wide `s3:*` grant to a foreign source account. It must SURFACE (not fold).
    const rogue = {
      Sid: 'AWSLogDeliveryWriteRogue',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:*',
      Resource: 'arn:aws:s3:::bucket/*',
      Condition: { StringEquals: { 'aws:SourceAccount': '999999999999' } },
    };
    const doc = canonicalizePolicy({ Statement: [rogue] });
    expect(stmtCount(doc)).toBe(1); // kept — a widening grant is visible drift
  });

  it('does NOT drop an AWSLogDelivery statement carrying an extra broad Action in an array', () => {
    const rogue = {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: ['s3:PutObject', 's3:DeleteObject'],
      Resource: 'arn:aws:s3:::bucket/AWSLogs/*',
    };
    const doc = canonicalizePolicy({ Statement: [rogue] });
    expect(stmtCount(doc)).toBe(1); // the extra s3:DeleteObject keeps the statement visible
  });

  it('does NOT drop an AWSLogDelivery statement flipped to Deny', () => {
    const rogue = {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Deny',
      Principal: deliveryPrincipal,
      Action: 's3:PutObject',
      Resource: 'arn:aws:s3:::bucket/AWSLogs/*',
    };
    const doc = canonicalizePolicy({ Statement: [rogue] });
    expect(stmtCount(doc)).toBe(1);
  });

  it('STILL drops the genuine AWSLogDeliveryWrite statement (Action s3:PutObject + acl condition)', () => {
    const genuineWrite = {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:PutObject',
      Resource: 'arn:aws:s3:::bucket/AWSLogs/123456789012/*',
      Condition: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
          'aws:SourceAccount': '123456789012',
        },
      },
    };
    const doc = canonicalizePolicy({ Statement: [genuineWrite] });
    expect(stmtCount(doc)).toBe(0); // legit vended statement still folds (no false positive)
  });

  it('STILL drops the genuine AWSLogDeliveryAclCheck statement (Action s3:GetBucketAcl)', () => {
    const genuineAclCheck = {
      Sid: 'AWSLogDeliveryAclCheck',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:GetBucketAcl',
      Resource: 'arn:aws:s3:::bucket',
      Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
    };
    const doc = canonicalizePolicy({ Statement: [genuineAclCheck] });
    expect(stmtCount(doc)).toBe(0);
  });

  it('STILL drops the genuine CloudWatch Logs vended statement (logs:CreateLogStream/PutLogEvents)', () => {
    // A Logs::LogGroup resource policy vends this statement — a different destination than
    // S3, with logs:* actions. It must still fold (this shape appears in the corpus).
    const genuineLogs = {
      Sid: 'AWSLogDeliveryWrite1',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: 'arn:aws:logs:us-east-1:111111111111:log-group:/aws/vendedlogs/x:log-stream:*',
      Condition: {
        StringEquals: { 'aws:SourceAccount': '111111111111' },
        ArnLike: { 'aws:SourceArn': 'arn:aws:logs:us-east-1:111111111111:*' },
      },
    };
    const doc = canonicalizePolicy({ Statement: [genuineLogs] });
    expect(stmtCount(doc)).toBe(0);
  });

  it('STILL drops the genuine Firehose vended statement (firehose:PutRecord/PutRecordBatch)', () => {
    const genuineFirehose = {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
      Resource: 'arn:aws:firehose:us-east-1:111111111111:deliverystream/x',
    };
    const doc = canonicalizePolicy({ Statement: [genuineFirehose] });
    expect(stmtCount(doc)).toBe(0);
  });

  it('does NOT drop an AWSLogDelivery statement with a wildcard logs:* action', () => {
    const rogue = {
      Sid: 'AWSLogDeliveryWrite1',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 'logs:*',
      Resource: 'arn:aws:logs:us-east-1:111111111111:log-group:*',
    };
    const doc = canonicalizePolicy({ Statement: [rogue] });
    expect(stmtCount(doc)).toBe(1);
  });

  it('drops both genuine vended statements but keeps a co-located rogue one', () => {
    const genuineWrite = {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:PutObject',
      Resource: 'arn:aws:s3:::bucket/AWSLogs/*',
      Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
    };
    const genuineAclCheck = {
      Sid: 'AWSLogDeliveryAclCheck',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:GetBucketAcl',
      Resource: 'arn:aws:s3:::bucket',
    };
    const rogue = {
      Sid: 'AWSLogDeliveryWriteRogue',
      Effect: 'Allow',
      Principal: deliveryPrincipal,
      Action: 's3:*',
      Resource: 'arn:aws:s3:::bucket/*',
    };
    const doc = canonicalizePolicy({ Statement: [genuineWrite, genuineAclCheck, rogue] });
    expect(stmtCount(doc)).toBe(1); // only the rogue statement survives
    const surviving = (doc.Statement as Record<string, unknown>[])[0];
    expect(surviving.Sid).toBe('AWSLogDeliveryWriteRogue');
  });
});

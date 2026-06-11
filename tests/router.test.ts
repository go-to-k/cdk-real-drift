import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { readLive } from '../src/read/router.js';
import type { DesiredResource } from '../src/types.js';

const cc = mockClient(CloudControlClient);
const s3 = mockClient(S3Client);

const named = (name: string): Error => Object.assign(new Error(name), { name });

const res = (over: Partial<DesiredResource> = {}): DesiredResource => ({
  logicalId: 'L',
  resourceType: 'AWS::DynamoDB::Table',
  physicalId: 'phys',
  declared: {},
  ...over,
});

beforeEach(() => {
  cc.reset();
  s3.reset();
});

describe('readLive (CC API path)', () => {
  it('parses the live model on success', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"BillingMode":"PAY_PER_REQUEST"}' },
    });
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.live).toEqual({ BillingMode: 'PAY_PER_REQUEST' });
    expect(r.deleted).toBeUndefined();
  });

  it('maps ResourceNotFoundException to deleted (out-of-band deletion)', async () => {
    cc.on(GetResourceCommand).rejects(named('ResourceNotFoundException'));
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.deleted).toBe(true);
    expect(r.live).toBeUndefined();
    expect(r.skippedReason).toBeUndefined();
  });

  it('maps any OTHER CC error to skipped, not deleted', async () => {
    cc.on(GetResourceCommand).rejects(named('ThrottlingException'));
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('ThrottlingException');
  });
});

describe('readLive (custom resources short-circuit, R26)', () => {
  it('returns skipped WITHOUT calling Cloud Control for a Custom:: resource', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'Custom::S3AutoDeleteObjects' }),
      'us-east-1',
      '1'
    );
    expect(r.skippedReason).toContain('custom resource');
    expect(r.live).toBeUndefined();
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(0); // no wasted API call
  });

  it('also short-circuits AWS::CloudFormation::CustomResource', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::CloudFormation::CustomResource' }),
      'us-east-1',
      '1'
    );
    expect(r.skippedReason).toContain('custom resource');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(0);
  });
});

describe('readLive (SDK override path)', () => {
  const bucketPolicy = res({
    resourceType: 'AWS::S3::BucketPolicy',
    declared: { Bucket: 'my-bucket' },
  });

  it('maps an override not-found error (NoSuchBucketPolicy) to deleted', async () => {
    s3.on(GetBucketPolicyCommand).rejects(named('NoSuchBucketPolicy'));
    const r = await readLive(cc as unknown as CloudControlClient, bucketPolicy, 'us-east-1', '1');
    expect(r.deleted).toBe(true);
  });

  it('maps any OTHER override error to skipped, not deleted', async () => {
    s3.on(GetBucketPolicyCommand).rejects(named('AccessDenied'));
    const r = await readLive(cc as unknown as CloudControlClient, bucketPolicy, 'us-east-1', '1');
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('AccessDenied');
  });

  it('returns skipped (not deleted) when the override cannot resolve its target', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::S3::BucketPolicy', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('not resolvable');
  });
});

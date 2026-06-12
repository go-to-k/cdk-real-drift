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

describe('readLive (CC identifier adapters, R74)', () => {
  const sent = (): string =>
    (cc.commandCalls(GetResourceCommand)[0]?.args[0].input.Identifier ?? '') as string;

  it('AppSync GraphQLApi: the ARN physical id is reduced to the bare ApiId', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AppSync::GraphQLApi',
        physicalId: 'arn:aws:appsync:us-east-1:111111111111:apis/abc123xyz',
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('abc123xyz');
  });

  it('AppSync GraphQLApi: a non-ARN physical id passes through unchanged', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::AppSync::GraphQLApi', physicalId: 'abc123xyz' }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('abc123xyz');
  });

  it('Cognito UserPoolClient: builds the composite UserPoolId|ClientId identifier', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Cognito::UserPoolClient',
        physicalId: 'client123',
        declared: { UserPoolId: 'us-east-1_AbCdEf' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('us-east-1_AbCdEf|client123');
  });

  it('Cognito UserPoolClient: an unresolved UserPoolId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::Cognito::UserPoolClient', physicalId: 'client123', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('client123');
  });

  it('types without an adapter keep the physical id as the identifier', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(sent()).toBe('phys');
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

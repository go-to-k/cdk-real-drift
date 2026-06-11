import { describe, expect, it } from 'vite-plus/test';
import { isResourceNotFoundError, isStackNotDeployed } from '../src/aws-errors.js';

const named = (name: string): Error => Object.assign(new Error(name), { name });

describe('isResourceNotFoundError', () => {
  it('matches every override + CC not-found error name', () => {
    for (const n of [
      'ResourceNotFoundException', // CC API + Lambda
      'NoSuchBucket',
      'NoSuchBucketPolicy', // S3
      'QueueDoesNotExist',
      'AWS.SimpleQueueService.NonExistentQueue', // SQS
      'NotFoundException', // SNS + Budgets
      'NoSuchEntity',
      'NoSuchEntityException', // IAM
      'InvalidAllocationID.NotFound',
      'InvalidAddress.NotFound', // EC2 EIP
    ]) {
      expect(isResourceNotFoundError(named(n))).toBe(true);
    }
  });

  it('also matches the legacy .Code field shape', () => {
    expect(isResourceNotFoundError({ Code: 'NoSuchBucket' })).toBe(true);
  });

  it('does NOT match unrelated errors (throttling / access denied)', () => {
    expect(isResourceNotFoundError(named('ThrottlingException'))).toBe(false);
    expect(isResourceNotFoundError(named('AccessDenied'))).toBe(false);
    expect(isResourceNotFoundError(new Error('boom'))).toBe(false);
  });
});

describe('isStackNotDeployed', () => {
  it('matches CFn does-not-exist / ValidationError stack errors', () => {
    expect(isStackNotDeployed(new Error('Stack with id X does not exist'))).toBe(true);
    expect(isStackNotDeployed(named('ValidationError'))).toBe(false); // needs "stack" in message
  });
});

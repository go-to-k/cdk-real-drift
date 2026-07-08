import { describe, expect, it } from 'vite-plus/test';
import {
  classifyStackStatus,
  isResourceNotFoundError,
  isStackNotDeployed,
  ResourceGoneError,
} from '../src/aws-errors.js';

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
      'InvalidLaunchTemplateId.NotFound', // EC2 DescribeLaunchTemplateVersions (deleted template)
      'InvalidNetworkAclID.NotFound', // EC2 DescribeNetworkAcls (deleted NACL of a NetworkAclEntry)
      'EntityNotFoundException', // Glue GetTable on a deleted table/db
      'DBClusterNotFoundFault', // DocumentDB describe-db-clusters
      'DBInstanceNotFoundFault', // DocumentDB describe-db-instances
      'NamespaceNotFound', // Cloud Map GetNamespace
      'ServiceNotFound', // Cloud Map GetService
      'ResourceNotFoundFault', // DMS Describe{Endpoints,ReplicationSubnetGroups}
      'ClusterNotFoundFault', // DAX DescribeClusters
      'ParameterGroupNotFoundFault', // DAX DescribeParameterGroups
      'SubnetGroupNotFoundFault', // DAX DescribeSubnetGroups
      'CacheParameterGroupNotFoundFault', // ElastiCache DescribeCacheParameterGroups
      'NoSuchHostedZone', // Route53 ListResourceRecordSets (deleted hosted zone)
      'RuleSetDoesNotExistException', // SES DescribeReceiptRuleSet
      'RuleDoesNotExistException', // SES DescribeReceiptRule
    ]) {
      expect(isResourceNotFoundError(named(n))).toBe(true);
    }
  });

  it('also matches the legacy .Code field shape', () => {
    expect(isResourceNotFoundError({ Code: 'NoSuchBucket' })).toBe(true);
  });

  it('recognizes ResourceGoneError so a list/describe-absent reader maps to deleted', () => {
    expect(isResourceNotFoundError(new ResourceGoneError('record absent from zone'))).toBe(true);
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

describe('classifyStackStatus (stack-state checkability)', () => {
  it('REVIEW_IN_PROGRESS → skip (change set never deployed)', () => {
    const c = classifyStackStatus('REVIEW_IN_PROGRESS');
    expect(c.kind).toBe('skip');
    expect(c.message).toMatch(/never deployed/);
  });

  it('DELETE_IN_PROGRESS → skip (being deleted)', () => {
    expect(classifyStackStatus('DELETE_IN_PROGRESS').kind).toBe('skip');
  });

  it('other *_IN_PROGRESS → warn (mid-operation)', () => {
    for (const s of ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS']) {
      const c = classifyStackStatus(s);
      expect(c.kind).toBe('warn');
      expect(c.message).toContain(s);
    }
  });

  it('*_FAILED → warn (may not match reality)', () => {
    for (const s of ['CREATE_FAILED', 'UPDATE_FAILED', 'UPDATE_ROLLBACK_FAILED']) {
      expect(classifyStackStatus(s).kind).toBe('warn');
    }
  });

  it('stable *_COMPLETE states (incl. rollback/import complete) → ok', () => {
    for (const s of [
      'CREATE_COMPLETE',
      'UPDATE_COMPLETE',
      'ROLLBACK_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
      'IMPORT_COMPLETE',
      undefined,
    ]) {
      expect(classifyStackStatus(s).kind).toBe('ok');
    }
  });
});

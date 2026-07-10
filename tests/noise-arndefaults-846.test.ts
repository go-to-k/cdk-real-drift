// #846: three derived CONTEXT_ARN_DEFAULTS entries — the AWS-managed service-linked-role /
// AWS-managed-KMS ARNs AWS attaches when the property is UNDECLARED. Each is
// f(partition, region, accountId), equality-gated: the exact default folds to atDefault, but a
// value pointed at a DIFFERENT role / key still surfaces as real undeclared drift (detection
// preserved). Batch ServiceRole + CodeBuild EncryptionKey are corpus baked FPs; SSM
// MaintenanceWindowTask ServiceRoleArn is a live-confirmed instance (hunt-v, us-east-1).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const opts = { accountId: '111111111111', region: 'us-east-1' };

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#846 Batch ComputeEnvironment ServiceRole default SLR', () => {
  const res: DesiredResource = {
    logicalId: 'FargateCE',
    resourceType: 'AWS::Batch::ComputeEnvironment',
    physicalId: 'arn:aws:batch:us-east-1:111111111111:compute-environment/FargateCE',
    declared: { Type: 'MANAGED' },
  };
  it('folds the AWS-managed Batch SLR ARN to atDefault', () => {
    const f = classifyResource(
      res,
      {
        ServiceRole:
          'arn:aws:iam::111111111111:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch',
      },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('ServiceRole');
    expect(pathsByTier(f, 'undeclared')).not.toContain('ServiceRole');
  });
  it('surfaces a custom service role as undeclared', () => {
    const f = classifyResource(
      res,
      { ServiceRole: 'arn:aws:iam::111111111111:role/my-custom-batch-role' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toContain('ServiceRole');
    expect(pathsByTier(f, 'atDefault')).not.toContain('ServiceRole');
  });
});

describe('#846 CodeBuild Project EncryptionKey default alias/aws/s3', () => {
  const res: DesiredResource = {
    logicalId: 'Build',
    resourceType: 'AWS::CodeBuild::Project',
    physicalId: 'my-build',
    declared: { Name: 'my-build' },
  };
  it('folds the AWS-managed alias/aws/s3 key ARN to atDefault', () => {
    const f = classifyResource(
      res,
      { EncryptionKey: 'arn:aws:kms:us-east-1:111111111111:alias/aws/s3' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('EncryptionKey');
    expect(pathsByTier(f, 'undeclared')).not.toContain('EncryptionKey');
  });
  it('surfaces a customer CMK as undeclared', () => {
    const f = classifyResource(
      res,
      {
        EncryptionKey:
          'arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012',
      },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toContain('EncryptionKey');
    expect(pathsByTier(f, 'atDefault')).not.toContain('EncryptionKey');
  });
});

describe('#846 SSM MaintenanceWindowTask ServiceRoleArn default SLR', () => {
  const res: DesiredResource = {
    logicalId: 'MaintTask',
    resourceType: 'AWS::SSM::MaintenanceWindowTask',
    physicalId: 'task-id',
    declared: { WindowId: 'mw-123', TaskType: 'RUN_COMMAND' },
  };
  it('folds the AWS-managed SSM SLR ARN to atDefault', () => {
    const f = classifyResource(
      res,
      {
        ServiceRoleArn:
          'arn:aws:iam::111111111111:role/aws-service-role/ssm.amazonaws.com/AWSServiceRoleForAmazonSSM',
      },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('ServiceRoleArn');
    expect(pathsByTier(f, 'undeclared')).not.toContain('ServiceRoleArn');
  });
  it('surfaces a custom service role as undeclared', () => {
    const f = classifyResource(
      res,
      { ServiceRoleArn: 'arn:aws:iam::111111111111:role/my-custom-ssm-role' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toContain('ServiceRoleArn');
    expect(pathsByTier(f, 'atDefault')).not.toContain('ServiceRoleArn');
  });
});

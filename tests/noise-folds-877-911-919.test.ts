// First-run fold gaps mined from clean, un-mutated LIVE deploys (issues #877, #919, #911).
// Each fold is equality-gated (case-insensitive for #877, constant for the KNOWN_DEFAULTS
// entries, account-derived for #919 BucketAccountId), so a change away from the default still
// surfaces — every fix asserts BOTH the fold (no drift on a clean deploy) AND that a genuine
// divergence still surfaces.
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#877 EC2 SecurityGroup rule IpProtocol case-normalized by EC2', () => {
  const res: DesiredResource = {
    logicalId: 'Sg',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-1',
    declared: {
      GroupDescription: 'demo',
      SecurityGroupIngress: [
        { IpProtocol: 'TCP', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ],
      SecurityGroupEgress: [{ IpProtocol: 'UDP', FromPort: 53, ToPort: 53, CidrIp: '0.0.0.0/0' }],
    },
  };
  it('does not flag declared drift when EC2 lowercases the declared IpProtocol', () => {
    const live = {
      GroupDescription: 'demo',
      SecurityGroupIngress: [
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ],
      SecurityGroupEgress: [{ IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '0.0.0.0/0' }],
    };
    const f = classifyResource(res, live, emptySchema);
    expect(pathsByTier(f, 'declared')).not.toContain('SecurityGroupIngress.0.IpProtocol');
    expect(pathsByTier(f, 'declared')).not.toContain('SecurityGroupEgress.0.IpProtocol');
  });
  it('surfaces a real protocol change (tcp -> udp) as declared drift', () => {
    const live = {
      GroupDescription: 'demo',
      SecurityGroupIngress: [
        { IpProtocol: 'udp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ],
      SecurityGroupEgress: [{ IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '0.0.0.0/0' }],
    };
    const f = classifyResource(res, live, emptySchema);
    expect(pathsByTier(f, 'declared')).toContain('SecurityGroupIngress.0.IpProtocol');
  });
});

describe('#877 standalone SecurityGroupIngress/Egress IpProtocol case-normalized', () => {
  const mk = (type: string): DesiredResource => ({
    logicalId: 'Rule',
    resourceType: type,
    physicalId: 'rule',
    declared: {
      GroupId: 'sg-1',
      IpProtocol: 'TCP',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
    },
  });
  it('folds a lowercased IpProtocol on the ingress rule type', () => {
    const f = classifyResource(
      mk('AWS::EC2::SecurityGroupIngress'),
      { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).not.toContain('IpProtocol');
  });
  it('folds a lowercased IpProtocol on the egress rule type', () => {
    const f = classifyResource(
      mk('AWS::EC2::SecurityGroupEgress'),
      { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).not.toContain('IpProtocol');
  });
  it('surfaces a real protocol change on the standalone rule type', () => {
    const f = classifyResource(
      mk('AWS::EC2::SecurityGroupIngress'),
      { GroupId: 'sg-1', IpProtocol: 'udp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toContain('IpProtocol');
  });
});

describe('#919 S3 AccessPoint undeclared creation defaults', () => {
  const res: DesiredResource = {
    logicalId: 'Ap',
    resourceType: 'AWS::S3::AccessPoint',
    physicalId: 'ap',
    declared: { Bucket: 'my-bucket', Name: 'my-ap' },
  };
  const opts = { accountId: '123456789012', region: 'us-east-1' };
  const defaultPab = {
    RestrictPublicBuckets: true,
    BlockPublicPolicy: true,
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
  };
  it('folds the all-true PublicAccessBlockConfiguration to atDefault', () => {
    const f = classifyResource(
      res,
      { PublicAccessBlockConfiguration: defaultPab, BucketAccountId: '123456789012' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('PublicAccessBlockConfiguration');
    expect(pathsByTier(f, 'undeclared')).not.toContain('PublicAccessBlockConfiguration');
  });
  it('folds BucketAccountId equal to the deploying account id to atDefault', () => {
    const f = classifyResource(
      res,
      { PublicAccessBlockConfiguration: defaultPab, BucketAccountId: '123456789012' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('BucketAccountId');
    expect(pathsByTier(f, 'undeclared')).not.toContain('BucketAccountId');
  });
  it('surfaces an out-of-band relaxed PAB block as undeclared', () => {
    const f = classifyResource(
      res,
      {
        PublicAccessBlockConfiguration: { ...defaultPab, BlockPublicAcls: false },
        BucketAccountId: '123456789012',
      },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toContain('PublicAccessBlockConfiguration');
  });
  it('surfaces a BucketAccountId pointed at another account as undeclared', () => {
    const f = classifyResource(
      res,
      { PublicAccessBlockConfiguration: defaultPab, BucketAccountId: '999988887777' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'undeclared')).toContain('BucketAccountId');
  });
});

describe('#911 ImageBuilder undeclared creation defaults', () => {
  const infra: DesiredResource = {
    logicalId: 'Infra',
    resourceType: 'AWS::ImageBuilder::InfrastructureConfiguration',
    physicalId: 'infra',
    declared: { Name: 'infra', InstanceProfileName: 'prof' },
  };
  const pipeline: DesiredResource = {
    logicalId: 'Pipeline',
    resourceType: 'AWS::ImageBuilder::ImagePipeline',
    physicalId: 'pipeline',
    declared: { Name: 'pipeline', ImageRecipeArn: 'arn', InfrastructureConfigurationArn: 'arn' },
  };
  it('folds InfrastructureConfiguration TerminateInstanceOnFailure=true to atDefault', () => {
    const f = classifyResource(infra, { TerminateInstanceOnFailure: true }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('TerminateInstanceOnFailure');
    expect(pathsByTier(f, 'undeclared')).not.toContain('TerminateInstanceOnFailure');
  });
  it('folds ImagePipeline EnhancedImageMetadataEnabled + ImageTestsConfiguration to atDefault', () => {
    const f = classifyResource(
      pipeline,
      {
        EnhancedImageMetadataEnabled: true,
        ImageTestsConfiguration: { ImageTestsEnabled: true, TimeoutMinutes: 720 },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('EnhancedImageMetadataEnabled');
    expect(pathsByTier(f, 'atDefault')).toContain('ImageTestsConfiguration');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
  it('surfaces disabled image tests (ImageTestsEnabled=false) as undeclared', () => {
    const f = classifyResource(
      pipeline,
      {
        EnhancedImageMetadataEnabled: true,
        ImageTestsConfiguration: { ImageTestsEnabled: false, TimeoutMinutes: 720 },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('ImageTestsConfiguration');
    expect(pathsByTier(f, 'atDefault')).not.toContain('ImageTestsConfiguration');
  });
});

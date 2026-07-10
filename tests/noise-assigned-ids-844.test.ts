// #844: corpus baked first-run FPs — a batch of undeclared, AWS-assigned identifiers /
// generated names / AWS-managed cosmetic values that surfaced as undeclared [Potential Drift]
// instead of folding. Each is folded via the WEAKEST tier that fits (fold-strategy order):
//   - WAFv2 WebACL / RegexPatternSet Name -> GENERATED_LOGICALID_PREFIX_PATHS (generated, value-
//     dependent: a <logicalId>-<random> name folds, a user-SET name still surfaces).
//   - EC2 FlowLog LogFormat -> KNOWN_DEFAULTS (equality-gated constant: the stock 14-field default
//     folds, a custom format still surfaces).
//   - ApiGateway ApiKey Value / AmazonMQ Broker SecurityGroups+SubnetIds / Backup BackupVault
//     EncryptionKeyArn -> VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS (createOnly / AWS-assigned
//     placement / AWS-generated secret — undeclared, so any value is AWS's choice, not user intent).
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

describe('#844 WAFv2 WebACL/RegexPatternSet generated Name', () => {
  const webAcl: DesiredResource = {
    logicalId: 'Edge',
    resourceType: 'AWS::WAFv2::WebACL',
    physicalId: 'Edge-iCCoPGcllLnA|8db5286a-695e-41b6-beba-f4207a727afc|REGIONAL',
    declared: { Scope: 'REGIONAL' },
  };
  it('folds the CFn-generated <logicalId>-<random> Name to generated', () => {
    const f = classifyResource(webAcl, { Name: 'Edge-iCCoPGcllLnA' }, emptySchema, opts);
    expect(pathsByTier(f, 'generated')).toContain('Name');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Name');
  });
  it('surfaces a user-SET Name (no logical-id prefix) as undeclared', () => {
    const f = classifyResource(webAcl, { Name: 'my-custom-acl' }, emptySchema, opts);
    expect(pathsByTier(f, 'undeclared')).toContain('Name');
    expect(pathsByTier(f, 'generated')).not.toContain('Name');
  });
  it('folds a RegexPatternSet generated Name to generated', () => {
    const regexSet: DesiredResource = {
      logicalId: 'RegexSet',
      resourceType: 'AWS::WAFv2::RegexPatternSet',
      physicalId: 'RegexSet-CTQHtT5iegpr|86885cf4-7aa6-4169-92a4-c9d9ac32aed5|REGIONAL',
      declared: { Scope: 'REGIONAL' },
    };
    const f = classifyResource(regexSet, { Name: 'RegexSet-CTQHtT5iegpr' }, emptySchema, opts);
    expect(pathsByTier(f, 'generated')).toContain('Name');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Name');
  });
});

describe('#844 EC2 FlowLog default LogFormat', () => {
  const res: DesiredResource = {
    logicalId: 'FlowLog',
    resourceType: 'AWS::EC2::FlowLog',
    physicalId: 'fl-036ddfda22c64b9f1',
    declared: { ResourceType: 'VPC', TrafficType: 'ALL' },
  };
  const DEFAULT_FORMAT =
    '${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}';
  it('folds the stock 14-field default LogFormat to atDefault', () => {
    const f = classifyResource(res, { LogFormat: DEFAULT_FORMAT }, emptySchema, opts);
    expect(pathsByTier(f, 'atDefault')).toContain('LogFormat');
    expect(pathsByTier(f, 'undeclared')).not.toContain('LogFormat');
  });
  it('surfaces a custom LogFormat as undeclared', () => {
    const f = classifyResource(res, { LogFormat: '${version} ${srcaddr}' }, emptySchema, opts);
    expect(pathsByTier(f, 'undeclared')).toContain('LogFormat');
    expect(pathsByTier(f, 'atDefault')).not.toContain('LogFormat');
  });
});

describe('#844 ApiGateway ApiKey generated Value (value-independent)', () => {
  const res: DesiredResource = {
    logicalId: 'ApiKey',
    resourceType: 'AWS::ApiGateway::ApiKey',
    physicalId: '6r6yg8wk4j',
    declared: { Enabled: true, Name: 'cdkrd-key' },
  };
  it('folds AWS-generated key material to atDefault regardless of value', () => {
    const f = classifyResource(
      res,
      { Value: 'OL2cc3xWoX85uZuwBZpvO311UM7TN5ke2SyXoEYD' },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('Value');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Value');
  });
});

describe('#844 AmazonMQ Broker default-VPC placement (value-independent)', () => {
  const res: DesiredResource = {
    logicalId: 'Broker',
    resourceType: 'AWS::AmazonMQ::Broker',
    physicalId: 'b-ef12f21b-b6f6-41f8-9282-e98ffc5c0c86',
    declared: { BrokerName: 'cdkrd-mq', EngineType: 'ACTIVEMQ' },
  };
  it('folds AWS-assigned SecurityGroups/SubnetIds to atDefault', () => {
    const f = classifyResource(
      res,
      { SecurityGroups: ['sg-0a26e23e2310ee0c9'], SubnetIds: ['subnet-0ddbb00e7c1d5b679'] },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(['SecurityGroups', 'SubnetIds']);
    expect(pathsByTier(f, 'undeclared')).not.toContain('SecurityGroups');
    expect(pathsByTier(f, 'undeclared')).not.toContain('SubnetIds');
  });
});

describe('#844 Backup BackupVault default EncryptionKeyArn (value-independent)', () => {
  const res: DesiredResource = {
    logicalId: 'Vault',
    resourceType: 'AWS::Backup::BackupVault',
    physicalId: 'CdkrdVault',
    declared: { BackupVaultName: 'CdkrdVault' },
  };
  it('folds the AWS-managed aws/backup key ARN to atDefault', () => {
    const f = classifyResource(
      res,
      {
        EncryptionKeyArn:
          'arn:aws:kms:us-east-1:111111111111:key/b405e2ab-23b0-48e9-834e-aa3aeeded51d',
      },
      emptySchema,
      opts
    );
    expect(pathsByTier(f, 'atDefault')).toContain('EncryptionKeyArn');
    expect(pathsByTier(f, 'undeclared')).not.toContain('EncryptionKeyArn');
  });
});

// Two value-independent folds ESCALATED to detection-preserving gates:
//   #1284 — AWS::CloudFormation::Stack.RoleARN (the nested-stack CFn service role) was folded
//     value-independent (#723). But RoleARN is MUTABLE out of band (`update-stack --role-arn`,
//     which CFn REMEMBERS) and is a privilege boundary, so the fold hid a rogue exec-role swap
//     forever. It is now pattern-gated in DEFAULT_MANAGED_NAME_PATHS against the deterministic CDK
//     cfn-exec-role ARN shape: the `cdk-<qualifier>-cfn-exec-role-<acct>-<region>` role folds
//     atDefault; any other RoleARN surfaces as undeclared (recordable, then watched).
//   #1266 — AWS::AmazonMQ::Broker.SecurityGroups was folded value-independent (#844). But it is
//     OOB-mutable (`mq update-broker --security-groups`, NOT createOnly), so the fold hid a rogue
//     SG swap/append. It is now derive-gated through the same #889/#976 VPC-default-SG check.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, shouldFoldDefaultSgList } from '../src/diff/classify.js';
import { DEFAULT_MANAGED_NAME_PATHS } from '../src/normalize/noise.js';
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

// ---- #1284: nested-stack RoleARN pattern gate ----------------------------------------------
describe('#1284 AWS::CloudFormation::Stack.RoleARN pattern gate', () => {
  // A nested-stack parent resource that declares no RoleARN (the common case — CDK/AWS attaches it).
  const res = mk('AWS::CloudFormation::Stack', { TemplateURL: 'https://s3/child.json' });
  const CDK_EXEC_ROLE =
    'arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1';

  it('(a) folds the deterministic CDK cfn-exec-role ARN to atDefault (clean deploy, no drift)', () => {
    const f = classifyResource(res, { RoleARN: CDK_EXEC_ROLE }, emptySchema, {});
    expect(tier(f, 'atDefault')).toContain('RoleARN');
    expect(tier(f, 'undeclared')).not.toContain('RoleARN');
  });

  it('(b) SURFACES an out-of-band non-CDK RoleARN swap (update-stack --role-arn attacker)', () => {
    const f = classifyResource(
      res,
      { RoleARN: 'arn:aws:iam::123456789012:role/attacker-admin-role' },
      emptySchema,
      {}
    );
    expect(tier(f, 'undeclared')).toContain('RoleARN');
    expect(tier(f, 'atDefault')).not.toContain('RoleARN');
  });

  it('(c) folds a custom-qualifier cfn-exec-role and non-aws partitions; surfaces shape look-alikes', () => {
    const rx = DEFAULT_MANAGED_NAME_PATHS['AWS::CloudFormation::Stack']?.RoleARN;
    expect(rx).toBeInstanceOf(RegExp);
    if (!rx) throw new Error('unreachable');
    // custom bootstrap qualifier
    expect(
      rx.test('arn:aws:iam::123456789012:role/cdk-myqualif01-cfn-exec-role-123456789012-eu-west-2')
    ).toBe(true);
    // GovCloud / China partitions
    expect(
      rx.test(
        'arn:aws-us-gov:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-us-gov-west-1'
      )
    ).toBe(true);
    // NOT the cfn-exec-role: a different CDK role (file-publishing) must still surface
    expect(
      rx.test(
        'arn:aws:iam::123456789012:role/cdk-hnb659fds-file-publishing-role-123456789012-us-east-1'
      )
    ).toBe(false);
    // a role merely NAMED to look like one but with a bogus (non-12-digit) account is not folded
    expect(rx.test('arn:aws:iam::123:role/cdk-x-cfn-exec-role-123-us-east-1')).toBe(false);
  });
});

// ---- #1266: AmazonMQ Broker SecurityGroups derived gate -------------------------------------
const DEFAULT_SG = 'sg-0defau1t00000000';
const ROGUE_SG = 'sg-0rogue00000000000';
const defaultSgIds = new Set([DEFAULT_SG]);

describe('#1266 AWS::AmazonMQ::Broker.SecurityGroups derived VPC-default-SG gate', () => {
  // A broker declaring no SecurityGroups (so the live list is UNDECLARED and reaches the fold).
  const res = mk('AWS::AmazonMQ::Broker', { EngineType: 'ACTIVEMQ', BrokerName: 'b' });
  const key = 'SecurityGroups';

  it('(a) folds a single VPC-default SG to atDefault (clean deploy, no drift)', () => {
    const f = classifyResource(res, { [key]: [DEFAULT_SG] }, emptySchema, { defaultSgIds });
    expect(tier(f, 'atDefault')).toContain(key);
    expect(tier(f, 'undeclared')).not.toContain(key);
  });

  it('(b) SURFACES a 2-element list (out-of-band SG append via update-broker)', () => {
    const f = classifyResource(res, { [key]: [DEFAULT_SG, ROGUE_SG] }, emptySchema, {
      defaultSgIds,
    });
    expect(tier(f, 'undeclared')).toContain(key);
    expect(tier(f, 'atDefault')).not.toContain(key);
  });

  it('(c) SURFACES a single NON-default SG (out-of-band SG swap)', () => {
    const f = classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, { defaultSgIds });
    expect(tier(f, 'undeclared')).toContain(key);
    expect(tier(f, 'atDefault')).not.toContain(key);
  });

  it('(d) FOLDS on lookup failure (defaultSgIds absent → fail open, no first-run FP)', () => {
    const f = classifyResource(res, { [key]: [ROGUE_SG, DEFAULT_SG] }, emptySchema, {});
    expect(tier(f, 'atDefault')).toContain(key);
    expect(tier(f, 'undeclared')).not.toContain(key);
  });

  it('pure decision: shouldFoldDefaultSgList gates Broker SecurityGroups', () => {
    const b = 'AWS::AmazonMQ::Broker';
    expect(shouldFoldDefaultSgList(b, key, [DEFAULT_SG], defaultSgIds)).toBe(true);
    expect(shouldFoldDefaultSgList(b, key, [DEFAULT_SG, ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(b, key, [ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(b, key, [ROGUE_SG], undefined)).toBe(true);
    // SubnetIds stays value-independent (createOnly) — not this gate's business.
    expect(shouldFoldDefaultSgList(b, 'SubnetIds', ['subnet-x'], defaultSgIds)).toBe(false);
  });
});

import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { GetWebACLCommand, UpdateWebACLCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import {
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  DeleteRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  DescribeDBClustersCommand,
  DocDBClient,
  ModifyDBClusterCommand,
} from '@aws-sdk/client-docdb';
import {
  GetTopicAttributesCommand,
  SetTopicAttributesCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import {
  GetNamespaceCommand,
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
} from '@aws-sdk/client-servicediscovery';
import {
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import { resolveSdkWriter, SDK_WRITERS } from '../src/revert/writers.js';

const iam = mockClient(IAMClient);
const elb = mockClient(ElasticLoadBalancingV2Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const serviceDiscovery = mockClient(ServiceDiscoveryClient);
const docdb = mockClient(DocDBClient);
const cloudfront = mockClient(CloudFrontClient);
const wafv2 = mockClient(WAFV2Client);

const ARN = 'arn:aws:iam::123456789012:policy/p';
const ctx = (over: Partial<OverrideCtx> = {}): OverrideCtx => ({
  physicalId: ARN,
  declared: {},
  region: 'us-east-1',
  accountId: '123456789012',
  ...over,
});
const DESIRED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
};
const addOp = (value: unknown): PatchOp => ({
  op: 'add',
  path: '/PolicyDocument',
  value,
  human: 'PolicyDocument -> deployed-template value',
});

// the override reader for ManagedPolicy reads GetPolicy + GetPolicyVersion(default)
const stubReader = (currentDoc: unknown): void => {
  iam.on(GetPolicyCommand).resolves({ Policy: { Path: '/', DefaultVersionId: 'v1' } });
  iam
    .on(GetPolicyVersionCommand)
    .resolves({ PolicyVersion: { Document: JSON.stringify(currentDoc) } });
};

beforeEach(() => {
  iam.reset();
  elb.reset();
  sns.reset();
  sqs.reset();
  serviceDiscovery.reset();
  docdb.reset();
  cloudfront.reset();
  wafv2.reset();
});

describe('WAFv2 WebACL writer (CC UpdateResource rejects on empty Description)', () => {
  const PID = 'cdkrd-acl|abc-123|REGIONAL';
  const sampledOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/VisibilityConfig/SampledRequestsEnabled',
    value,
    human: 'VisibilityConfig.SampledRequestsEnabled -> deployed-template value',
  });
  it('reverts via GetWebACL -> apply ops -> UpdateWebACL, OMITTING the empty Description', async () => {
    // AWS returns Description: "" (empty); re-sending it via CC UpdateResource fails the
    // schema pattern. The writer omits it and re-sends every other updatable field.
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        ARN: 'arn:aws:wafv2:us-east-1:111111111111:regional/webacl/cdkrd-acl/abc-123',
        Description: '',
        DefaultAction: { Allow: {} },
        Rules: [{ Name: 'r1', Priority: 0 }],
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [sampledOp(true)]);
    const calls = wafv2.commandCalls(UpdateWebACLCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.Name).toBe('cdkrd-acl');
    expect(input.Id).toBe('abc-123');
    expect(input.Scope).toBe('REGIONAL');
    expect(input.LockToken).toBe('LOCK1');
    // the empty Description is OMITTED (the bug trigger)
    expect('Description' in input).toBe(false);
    // the reverted scalar is applied; Rules/DefaultAction round-trip verbatim
    expect(
      (input.VisibilityConfig as { SampledRequestsEnabled: boolean }).SampledRequestsEnabled
    ).toBe(true);
    expect(input.DefaultAction).toEqual({ Allow: {} });
    expect(input.Rules).toEqual([{ Name: 'r1', Priority: 0 }]);
  });

  it('keeps a NON-empty Description (only the empty one is dropped)', async () => {
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        Description: 'real description',
        DefaultAction: { Allow: {} },
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [sampledOp(true)]);
    expect(
      (
        wafv2.commandCalls(UpdateWebACLCommand)[0]!.args[0].input as unknown as Record<
          string,
          unknown
        >
      ).Description
    ).toBe('real description');
  });

  it('throws when the Name|Id|Scope physical id is malformed', async () => {
    await expect(
      SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: 'just-a-name' }), [sampledOp(true)])
    ).rejects.toThrow(/Name\|Id\|Scope/);
  });
});

describe('CloudFront Distribution writer (CC UpdateResource rejects partial patch)', () => {
  const ID = 'E123ABC';
  const commentOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/DistributionConfig/Comment',
    value,
    human: 'Comment -> deployed-template value',
  });
  it('reverts via GetDistributionConfig -> apply ops -> UpdateDistribution(IfMatch=ETag)', async () => {
    // GetDistributionConfig returns the DRIFTED live config + ETag; UpdateDistribution
    // re-submits the SAME config with only the reverted scalar changed (round-trips the
    // default ViewerCertificate verbatim, which the CC partial patch could not).
    cloudfront.on(GetDistributionConfigCommand).resolves({
      ETag: 'ETAG1',
      // partial live config stub (the writer round-trips it verbatim) — cast past the
      // full DistributionConfig required-field type for the test.
      DistributionConfig: {
        CallerReference: 'r',
        Comment: 'DRIFTED',
        Enabled: true,
        ViewerCertificate: { CloudFrontDefaultCertificate: true },
        Origins: { Quantity: 1, Items: [{ Id: 'o1', DomainName: 'a.example.com' }] },
      } as never,
    });
    cloudfront.on(UpdateDistributionCommand).resolves({});
    await SDK_WRITERS['AWS::CloudFront::Distribution'](ctx({ physicalId: ID }), [
      commentOp('the desired comment'),
    ]);
    const calls = cloudfront.commandCalls(UpdateDistributionCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as {
      Id: string;
      IfMatch: string;
      DistributionConfig: { Comment: string; ViewerCertificate: unknown; Origins: unknown };
    };
    expect(input.Id).toBe(ID);
    expect(input.IfMatch).toBe('ETAG1');
    // only Comment changed; the rest of the live config round-trips verbatim
    expect(input.DistributionConfig.Comment).toBe('the desired comment');
    expect(input.DistributionConfig.ViewerCertificate).toEqual({
      CloudFrontDefaultCertificate: true,
    });
    expect(input.DistributionConfig.Origins).toEqual({
      Quantity: 1,
      Items: [{ Id: 'o1', DomainName: 'a.example.com' }],
    });
  });

  it('throws when the distribution id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::CloudFront::Distribution'](ctx({ physicalId: '' }), [commentOp('x')])
    ).rejects.toThrow(/distribution id/);
  });
});

describe('DocDB DBCluster writer (CC read+write gap)', () => {
  const CLID = 'my-cluster';
  const retentionOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/BackupRetentionPeriod',
    value,
    human: 'BackupRetentionPeriod -> deployed-template value',
  });
  // the override reader (DescribeDBClusters) returns the DRIFTED live model
  const stubClusterRead = (over: Record<string, unknown> = {}): void => {
    docdb.on(DescribeDBClustersCommand).resolves({
      DBClusters: [{ DBClusterIdentifier: CLID, BackupRetentionPeriod: 5, ...over }],
    });
  };

  it('reverts BackupRetentionPeriod via ModifyDBCluster (ApplyImmediately), only the drifted prop', async () => {
    stubClusterRead();
    docdb.on(ModifyDBClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [retentionOp(3)]);
    const calls = docdb.commandCalls(ModifyDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      DBClusterIdentifier: CLID,
      ApplyImmediately: true,
      BackupRetentionPeriod: 3,
    });
  });

  it('does NOT send EngineVersion (off the safe-modify allowlist -> no accidental upgrade)', async () => {
    stubClusterRead({ EngineVersion: '4.0.0' });
    docdb.on(ModifyDBClusterCommand).resolves({});
    // a hypothetical EngineVersion revert op must be ignored (no modifiable param emitted)
    await SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [
      { op: 'add', path: '/EngineVersion', value: '5.0.0', human: 'x' },
    ]);
    expect(docdb.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
  });

  it('throws when the cluster identifier is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: '', declared: {} }), [retentionOp(3)])
    ).rejects.toThrow(/cluster identifier/);
  });
});

describe('ServiceDiscovery HttpNamespace writer (CC read+write gap)', () => {
  const NSID = 'ns-abc';
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Description',
    value,
    human: 'Description -> deployed-template value',
  });
  it('reverts Description via UpdateHttpNamespace, keyed by the namespace physical id', async () => {
    // reader (GetNamespace) returns the DRIFTED live value; the revert op carries the desired one.
    serviceDiscovery
      .on(GetNamespaceCommand)
      .resolves({ Namespace: { Name: 'shop', Description: 'DRIFTED' } });
    serviceDiscovery.on(UpdateHttpNamespaceCommand).resolves({ OperationId: 'op-1' });

    await SDK_WRITERS['AWS::ServiceDiscovery::HttpNamespace'](ctx({ physicalId: NSID }), [
      descOp('the desired description'),
    ]);

    const calls = serviceDiscovery.commandCalls(UpdateHttpNamespaceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      Id: NSID,
      Namespace: { Description: 'the desired description' },
    });
  });

  it('throws when the namespace id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::HttpNamespace'](ctx({ physicalId: '' }), [descOp('x')])
    ).rejects.toThrow(/namespace id/);
  });
});

describe('IAM ManagedPolicy writer', () => {
  it('creates a new default version carrying the reverted document', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const created = iam.commandCalls(CreatePolicyVersionCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      SetAsDefault: true,
      PolicyDocument: JSON.stringify(DESIRED),
    });
    expect(iam.commandCalls(DeletePolicyVersionCommand)).toHaveLength(0);
  });

  it('prunes the oldest NON-default version when 5 already exist before creating', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    const d = (s: string) => new Date(s);
    iam.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v5', IsDefaultVersion: true, CreateDate: d('2020-05-01') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: d('2020-02-01') },
        { VersionId: 'v1', IsDefaultVersion: false, CreateDate: d('2020-01-01') }, // oldest non-default
        { VersionId: 'v4', IsDefaultVersion: false, CreateDate: d('2020-04-01') },
        { VersionId: 'v3', IsDefaultVersion: false, CreateDate: d('2020-03-01') },
      ],
    });
    iam.on(DeletePolicyVersionCommand).resolves({});
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const deleted = iam.commandCalls(DeletePolicyVersionCommand);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.args[0].input).toMatchObject({ PolicyArn: ARN, VersionId: 'v1' });
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(1);
  });

  it('falls back to ctx.declared.ManagedPolicyArn when physicalId is not an arn', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](
      ctx({ physicalId: 'not-an-arn', declared: { ManagedPolicyArn: ARN } }),
      [addOp(DESIRED)]
    );

    expect(iam.commandCalls(CreatePolicyVersionCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
    });
  });

  it('throws when no managed policy arn can be resolved', async () => {
    await expect(
      SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx({ physicalId: 'x', declared: {} }), [
        addOp(DESIRED),
      ])
    ).rejects.toThrow(/managed policy arn/);
  });

  it('a statement-indexed op lands on the canonical statement, not the raw one (WAVE21)', async () => {
    // The live doc's RAW statement order differs from the canonical (sorted) order
    // classify compared. A finding at canonical Statement[1] (zzz:Write) must revert
    // THAT statement — not raw Statement[1] (aaa:Read). Before the fix the op corrupted
    // aaa:Read and left zzz:Write's HACKED resource unreverted.
    stubReader({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'zzz:Write', Resource: 'HACKED' }, // raw[0], canonical[1]
        { Effect: 'Allow', Action: 'aaa:Read', Resource: 'r2' }, // raw[1], canonical[0]
      ],
    });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    // revert the drifted zzz:Write Resource (canonical index 1) back to the declared value
    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [
      {
        op: 'add',
        path: '/PolicyDocument/Statement/1/Resource',
        value: ['r1'],
        human: 'PolicyDocument.Statement.1.Resource -> deployed-template value',
      },
    ]);

    const created = iam.commandCalls(CreatePolicyVersionCommand);
    expect(created).toHaveLength(1);
    const written = JSON.parse(created[0]!.args[0].input.PolicyDocument as string) as {
      Statement: { Action: string[]; Resource: unknown }[];
    };
    const byAction = (a: string) => written.Statement.find((s) => s.Action.includes(a));
    // the RIGHT statement was reverted...
    expect(byAction('zzz:Write')!.Resource).toEqual(['r1']);
    // ...and the unrelated statement was NOT corrupted (stayed r2)
    expect(byAction('aaa:Read')!.Resource).toEqual(['r2']);
  });
});

describe('IAM Role inline Policies prop-scoped writer', () => {
  const DOC = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
  };
  const writer = () => resolveSdkWriter('AWS::IAM::Role', [removePoliciesOp([])])!;
  const removePoliciesOp = (prior: unknown): PatchOp => ({
    op: 'remove',
    path: '/Policies',
    prior,
    human: 'Policies -> remove',
  });
  const addPoliciesOp = (value: unknown, prior: unknown): PatchOp => ({
    op: 'add',
    path: '/Policies',
    value,
    prior,
    human: 'Policies -> baseline value',
  });
  const roleCtx = ctx({ physicalId: 'my-role' });

  it('resolveSdkWriter finds the prop-scoped writer from the op pointer', () => {
    expect(resolveSdkWriter('AWS::IAM::Role', [removePoliciesOp([])])).toBeDefined();
    expect(
      resolveSdkWriter('AWS::IAM::Role', [{ op: 'remove', path: '/Description', human: '' }])
    ).toBeUndefined();
    expect(resolveSdkWriter('AWS::S3::BucketPolicy', [])).toBe(
      SDK_WRITERS['AWS::S3::BucketPolicy']
    );
  });

  it('remove: deletes ONLY the rogue policies named in prior (sibling policies untouched)', async () => {
    iam.on(DeleteRolePolicyCommand).resolves({});
    const rogue = [
      { PolicyName: 'rogue-a', PolicyDocument: DOC },
      { PolicyName: 'rogue-b', PolicyDocument: DOC },
    ];
    await writer()(roleCtx, [removePoliciesOp(rogue)]);
    const dels = iam.commandCalls(DeleteRolePolicyCommand);
    expect(dels.map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'rogue-a' },
      { RoleName: 'my-role', PolicyName: 'rogue-b' },
    ]);
    expect(iam.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it('add (baseline restore): puts every desired entry and deletes prior entries not in desired', async () => {
    iam.on(DeleteRolePolicyCommand).resolves({});
    iam.on(PutRolePolicyCommand).resolves({});
    const baseline = [{ PolicyName: 'kept', PolicyDocument: DOC }];
    const prior = [
      { PolicyName: 'kept', PolicyDocument: { changed: true } },
      { PolicyName: 'extra', PolicyDocument: DOC },
    ];
    await writer()(roleCtx, [addPoliciesOp(baseline, prior)]);
    expect(iam.commandCalls(DeleteRolePolicyCommand).map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'extra' },
    ]);
    expect(iam.commandCalls(PutRolePolicyCommand).map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'kept', PolicyDocument: JSON.stringify(DOC) },
    ]);
  });

  it('rejects a non-top-level Policies pointer (deep paths belong to Cloud Control)', async () => {
    await expect(
      writer()(roleCtx, [{ op: 'remove', path: '/Policies/0', prior: [], human: '' }])
    ).rejects.toThrow('unsupported inline-policy revert path');
  });

  it('a missing prior on a remove op is a safe no-op (never a bulk wipe)', async () => {
    await writer()(roleCtx, [{ op: 'remove', path: '/Policies', human: '' }]);
    expect(iam.commandCalls(DeleteRolePolicyCommand)).toHaveLength(0);
  });
});

describe('ELB attribute-bag prop-scoped writers (R78)', () => {
  const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/abc';
  const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/y/def';
  const attrOp = (path: string, attributeKey: string, value: unknown): PatchOp => ({
    op: 'add',
    path,
    value,
    attributeKey,
    human: `${path}[${attributeKey}] -> deployed-template value`,
  });

  it('resolveSdkWriter routes the bag property to the ELB prop writer', () => {
    expect(
      resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
        attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
      ])
    ).toBeDefined();
    expect(
      resolveSdkWriter('AWS::ElasticLoadBalancingV2::TargetGroup', [
        attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
      ])
    ).toBeDefined();
  });

  it('LoadBalancer: sends ONLY the declared attributes (Key=Value) to ModifyLoadBalancerAttributes', async () => {
    elb.on(ModifyLoadBalancerAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
      attrOp('/LoadBalancerAttributes', 'deletion_protection.enabled', 'false'),
    ]);
    const calls = elb.commandCalls(ModifyLoadBalancerAttributesCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      LoadBalancerArn: LB_ARN,
      Attributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ],
    });
  });

  it('LoadBalancer: a non-string desired value is stringified (ELB Values are strings)', async () => {
    elb.on(ModifyLoadBalancerAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', 120),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', 120),
    ]);
    expect(
      elb.commandCalls(ModifyLoadBalancerAttributesCommand)[0].args[0].input.Attributes
    ).toEqual([{ Key: 'idle_timeout.timeout_seconds', Value: '120' }]);
  });

  it('TargetGroup: sends to ModifyTargetGroupAttributes with the TG arn', async () => {
    elb.on(ModifyTargetGroupAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::TargetGroup', [
      attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
    ])!;
    await writer(ctx({ physicalId: TG_ARN }), [
      attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
    ]);
    expect(elb.commandCalls(ModifyTargetGroupAttributesCommand)[0].args[0].input).toEqual({
      TargetGroupArn: TG_ARN,
      Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }],
    });
  });

  it('no attribute-keyed ops -> no AWS call (never a blind write)', async () => {
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'x', '1'),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      { op: 'add', path: '/LoadBalancerAttributes', value: '1', human: '' },
    ]);
    expect(elb.commandCalls(ModifyLoadBalancerAttributesCommand)).toHaveLength(0);
  });
});

describe('policy writers revert ALL attachment targets (not just the first)', () => {
  it('IAM Policy: the inline policy is put on EVERY role, user and group', async () => {
    iam.on(GetRolePolicyCommand).resolves({ PolicyDocument: '{}' }); // reader reads the first role
    iam.on(PutRolePolicyCommand).resolves({});
    iam.on(PutUserPolicyCommand).resolves({});
    iam.on(PutGroupPolicyCommand).resolves({});
    await SDK_WRITERS['AWS::IAM::Policy'](
      ctx({
        declared: {
          PolicyName: 'p',
          Roles: ['role-a', 'role-b'],
          Users: ['user-a'],
          Groups: ['group-a'],
        },
      }),
      [addOp(DESIRED)]
    );
    expect(iam.commandCalls(PutRolePolicyCommand).map((c) => c.args[0].input.RoleName)).toEqual([
      'role-a',
      'role-b',
    ]);
    expect(iam.commandCalls(PutUserPolicyCommand).map((c) => c.args[0].input.UserName)).toEqual([
      'user-a',
    ]);
    expect(iam.commandCalls(PutGroupPolicyCommand).map((c) => c.args[0].input.GroupName)).toEqual([
      'group-a',
    ]);
  });

  it('IAM Policy: no target throws', async () => {
    await expect(
      SDK_WRITERS['AWS::IAM::Policy'](ctx({ declared: { PolicyName: 'p' } }), [addOp(DESIRED)])
    ).rejects.toThrow('no role/user/group target');
  });

  it('SNS TopicPolicy: the policy is set on EVERY topic', async () => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: '{}' } });
    sns.on(SetTopicAttributesCommand).resolves({});
    await SDK_WRITERS['AWS::SNS::TopicPolicy'](
      ctx({ declared: { Topics: ['arn:aws:sns:us-east-1:1:t1', 'arn:aws:sns:us-east-1:1:t2'] } }),
      [addOp(DESIRED)]
    );
    expect(
      sns.commandCalls(SetTopicAttributesCommand).map((c) => c.args[0].input.TopicArn)
    ).toEqual(['arn:aws:sns:us-east-1:1:t1', 'arn:aws:sns:us-east-1:1:t2']);
  });

  it('SQS QueuePolicy: the policy is set on EVERY queue', async () => {
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: '{}' } });
    sqs.on(SetQueueAttributesCommand).resolves({});
    await SDK_WRITERS['AWS::SQS::QueuePolicy'](
      ctx({ declared: { Queues: ['https://sqs/q1', 'https://sqs/q2'] } }),
      [addOp(DESIRED)]
    );
    expect(
      sqs.commandCalls(SetQueueAttributesCommand).map((c) => c.args[0].input.QueueUrl)
    ).toEqual(['https://sqs/q1', 'https://sqs/q2']);
  });
});

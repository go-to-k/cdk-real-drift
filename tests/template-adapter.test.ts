import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListExportsCommand,
  ListStackResourcesCommand,
  type StackStatus,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  buildResolverContext,
  collectClustersWithSiblingCapacityProviders,
  collectPrincipalsWithSiblingPolicies,
  deletedResourceInfo,
  loadDesired,
  parseTemplateBody,
  typeChangedResources,
  typeChangeReplaceInfo,
} from '../src/desired/template-adapter.js';
import { StackNotCheckableError } from '../src/aws-errors.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';

describe('collectPrincipalsWithSiblingPolicies', () => {
  it('maps roles referenced by sibling AWS::IAM::Policy resources to the policy NAMES', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      MyPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'MyRoleDefaultPolicyABC', Roles: [{ Ref: 'MyRole' }] },
      },
      ExtraPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'extra', Roles: [{ Ref: 'MyRole' }] },
      },
      Other: { Type: 'AWS::S3::Bucket' },
    };
    expect(collectPrincipalsWithSiblingPolicies(resources)).toEqual(
      new Map([['MyRole', ['MyRoleDefaultPolicyABC', 'extra']]])
    );
  });

  it('ignores non-Ref role entries and non-policy resources', () => {
    const resources = {
      P: { Type: 'AWS::IAM::Policy', Properties: { PolicyName: 'p', Roles: ['literal-name'] } },
      Q: { Type: 'AWS::IAM::ManagedPolicy', Properties: { Roles: [{ Ref: 'R' }] } },
    };
    expect(collectPrincipalsWithSiblingPolicies(resources).size).toBe(0); // literal not a Ref; ManagedPolicy not Policy
  });

  it("marks the role 'unresolved' when a sibling PolicyName cannot be resolved (sticky)", () => {
    const resources = {
      A: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'literal', Roles: [{ Ref: 'MyRole' }] },
      },
      B: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: { 'Fn::GetAtt': ['X', 'Y'] }, Roles: [{ Ref: 'MyRole' }] },
      },
      C: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'after', Roles: [{ Ref: 'MyRole' }] },
      },
    };
    // no ctx -> the intrinsic cannot resolve; 'unresolved' wins and stays
    expect(collectPrincipalsWithSiblingPolicies(resources).get('MyRole')).toBe('unresolved');
  });

  it('resolves an intrinsic PolicyName when a resolver ctx is provided', () => {
    const resources = {
      P: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: { 'Fn::Sub': 'pol-${AWS::Region}' },
          Roles: [{ Ref: 'MyRole' }],
        },
      },
    };
    const ctx = buildResolverContext({}, {}, {}, 'us-east-1', '111122223333', 's', 'sid');
    expect(collectPrincipalsWithSiblingPolicies(resources, ctx).get('MyRole')).toEqual([
      'pol-us-east-1',
    ]);
  });

  it('also maps Users and Groups a sibling policy attaches to (db2bq IAM User pattern)', () => {
    const resources = {
      MyUser: { Type: 'AWS::IAM::User' },
      MyGroup: { Type: 'AWS::IAM::Group' },
      UserPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'UserDefaultPolicyA55', Users: [{ Ref: 'MyUser' }] },
      },
      GroupPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'GroupDefaultPolicyB33', Groups: [{ Ref: 'MyGroup' }] },
      },
    };
    const m = collectPrincipalsWithSiblingPolicies(resources);
    expect(m.get('MyUser')).toEqual(['UserDefaultPolicyA55']);
    expect(m.get('MyGroup')).toEqual(['GroupDefaultPolicyB33']);
  });

  it('also maps standalone RolePolicy/UserPolicy/GroupPolicy inline-policy types (#697)', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      MyUser: { Type: 'AWS::IAM::User' },
      MyGroup: { Type: 'AWS::IAM::Group' },
      RolePol: {
        Type: 'AWS::IAM::RolePolicy',
        Properties: { PolicyName: 'RoleInlineA', RoleName: { Ref: 'MyRole' } },
      },
      UserPol: {
        Type: 'AWS::IAM::UserPolicy',
        Properties: { PolicyName: 'UserInlineB', UserName: { Ref: 'MyUser' } },
      },
      GroupPol: {
        Type: 'AWS::IAM::GroupPolicy',
        Properties: { PolicyName: 'GroupInlineC', GroupName: { Ref: 'MyGroup' } },
      },
    };
    const m = collectPrincipalsWithSiblingPolicies(resources);
    expect(m.get('MyRole')).toEqual(['RoleInlineA']);
    expect(m.get('MyUser')).toEqual(['UserInlineB']);
    expect(m.get('MyGroup')).toEqual(['GroupInlineC']);
  });

  it('merges standalone RolePolicy names with an AWS::IAM::Policy on the same role (#697)', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      DefaultPol: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'RoleDefaultPolicyABC', Roles: [{ Ref: 'MyRole' }] },
      },
      StandalonePol: {
        Type: 'AWS::IAM::RolePolicy',
        Properties: { PolicyName: 'RoleInlineStandalone', RoleName: { Ref: 'MyRole' } },
      },
    };
    // does not regress the existing AWS::IAM::Policy handling: BOTH names present
    expect(collectPrincipalsWithSiblingPolicies(resources).get('MyRole')).toEqual([
      'RoleDefaultPolicyABC',
      'RoleInlineStandalone',
    ]);
  });

  it("marks the principal 'unresolved' for a standalone type with an unresolvable PolicyName (#697)", () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      RolePol: {
        Type: 'AWS::IAM::RolePolicy',
        Properties: { PolicyName: { 'Fn::GetAtt': ['X', 'Y'] }, RoleName: { Ref: 'MyRole' } },
      },
    };
    expect(collectPrincipalsWithSiblingPolicies(resources).get('MyRole')).toBe('unresolved');
  });

  it('ignores a standalone type whose principal is a literal name, not a Ref (#697)', () => {
    const resources = {
      RolePol: {
        Type: 'AWS::IAM::RolePolicy',
        Properties: { PolicyName: 'p', RoleName: 'literal-role-name' },
      },
    };
    expect(collectPrincipalsWithSiblingPolicies(resources).size).toBe(0); // literal has no logicalId
  });
});

describe('collectClustersWithSiblingCapacityProviders', () => {
  it('collects ECS Cluster logicalIds referenced by a ClusterCapacityProviderAssociations sibling', () => {
    const resources = {
      MyCluster: { Type: 'AWS::ECS::Cluster' },
      Assoc: {
        Type: 'AWS::ECS::ClusterCapacityProviderAssociations',
        Properties: {
          Cluster: { Ref: 'MyCluster' },
          CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
          DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
        },
      },
      Other: { Type: 'AWS::ECS::Cluster' }, // no association -> not collected
    };
    const s = collectClustersWithSiblingCapacityProviders(resources);
    expect(s.has('MyCluster')).toBe(true);
    expect(s.has('Other')).toBe(false);
  });

  it('ignores a non-Ref Cluster and non-association resources', () => {
    const resources = {
      A: {
        Type: 'AWS::ECS::ClusterCapacityProviderAssociations',
        Properties: { Cluster: 'literal-cluster-name' },
      },
    };
    expect(collectClustersWithSiblingCapacityProviders(resources).size).toBe(0);
  });
});

describe('buildResolverContext', () => {
  it('merges template defaults with deployed params (deployed wins) + sets pseudo', () => {
    const template = {
      Parameters: { Env: { Default: 'dev' }, Other: { Default: 'x' } },
      Conditions: { C: true },
      Mappings: { RegionMap: { 'us-west-2': { ami: 'ami-1' } } },
    };
    const ctx = buildResolverContext(
      template,
      { Env: 'prod' },
      { Log: 'phys' },
      'us-west-2',
      '999',
      'S',
      'arn:stack'
    );
    expect(ctx.params.Env).toBe('prod'); // deployed value wins
    expect(ctx.params.Other).toBe('x'); // template default kept
    expect(ctx.pseudo['AWS::Region']).toBe('us-west-2');
    expect(ctx.pseudo['AWS::AccountId']).toBe('999');
    expect(ctx.physIds.Log).toBe('phys');
    expect(ctx.conditions.C).toBe(true);
    expect(ctx.mappings.RegionMap['us-west-2'].ami).toBe('ami-1'); // Mappings carried for FindInMap
    expect(ctx.exports).toEqual({}); // empty until loadDesired prefetches (only when needed)
  });

  it('resolves CommaDelimitedList / List<> params to trimmed arrays', () => {
    const template = {
      Parameters: {
        Subnets: { Type: 'List<AWS::EC2::Subnet::Id>' },
        Csv: { Type: 'CommaDelimitedList', Default: 'x, y' },
        Plain: { Type: 'String' },
      },
    };
    const ctx = buildResolverContext(
      template,
      { Subnets: 'subnet-1, subnet-2 ,subnet-3', Plain: 'a,b' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn:stack'
    );
    // CloudFormation trims each element of a delimited list; mirror it so a
    // Fn::Select / membership test matches the deployed value (no " subnet-2").
    expect(ctx.params.Subnets).toEqual(['subnet-1', 'subnet-2', 'subnet-3']);
    expect(ctx.params.Csv).toEqual(['x', 'y']); // template Default also trimmed
    expect(ctx.params.Plain).toBe('a,b'); // a plain String param is NOT split
  });

  it('resolves an empty delimited-list value to an empty array', () => {
    const template = { Parameters: { L: { Type: 'CommaDelimitedList' } } };
    const ctx = buildResolverContext(template, { L: '' }, {}, 'us-east-1', '999', 'S', 'arn');
    expect(ctx.params.L).toEqual([]);
  });

  it('derives AWS::Partition / AWS::URLSuffix from the region (#730)', () => {
    // CDK env-agnostic stacks emit ${AWS::Partition} inside nearly every ARN; hard-coding
    // `aws`/`amazonaws.com` FPs every declared ARN in GovCloud/China/ISO partitions.
    const partOf = (region: string) => {
      const ctx = buildResolverContext({}, {}, {}, region, '999', 'S', 'arn');
      return { p: ctx.pseudo['AWS::Partition'], u: ctx.pseudo['AWS::URLSuffix'] };
    };
    expect(partOf('us-east-1')).toEqual({ p: 'aws', u: 'amazonaws.com' });
    expect(partOf('eu-west-3')).toEqual({ p: 'aws', u: 'amazonaws.com' });
    expect(partOf('us-gov-west-1')).toEqual({ p: 'aws-us-gov', u: 'amazonaws.com' });
    expect(partOf('cn-north-1')).toEqual({ p: 'aws-cn', u: 'amazonaws.com.cn' });
    expect(partOf('cn-northwest-1')).toEqual({ p: 'aws-cn', u: 'amazonaws.com.cn' });
    expect(partOf('us-iso-east-1')).toEqual({ p: 'aws-iso', u: 'c2s.ic.gov' });
    // us-isob-/us-isof- must NOT be swallowed by the us-iso- prefix test.
    expect(partOf('us-isob-east-1')).toEqual({ p: 'aws-iso-b', u: 'sc2s.sgov.gov' });
    expect(partOf('us-isof-south-1')).toEqual({ p: 'aws-iso-f', u: 'csp.hci.ic.gov' });
    expect(partOf('eu-isoe-west-1')).toEqual({ p: 'aws-iso-e', u: 'cloud.adc-e.uk' });
  });

  it('splits an SSM list-typed param (Parameter::Value<List<...>>) to a trimmed array (#745)', () => {
    // An SSM list param's deployed ResolvedValue is a COMMA-JOINED string; it must split to
    // an array or a list-typed property (SecurityGroupIds/Subnets) Ref'ing it is a declared
    // FP (declared "sg-a,sg-b" vs live ["sg-a","sg-b"]).
    const template = {
      Parameters: {
        Sgs: { Type: 'AWS::SSM::Parameter::Value<List<AWS::EC2::SecurityGroup::Id>>' },
        Csv: { Type: 'AWS::SSM::Parameter::Value<CommaDelimitedList>' },
        Plain: { Type: 'AWS::SSM::Parameter::Value<String>' },
      },
    };
    const ctx = buildResolverContext(
      template,
      { Sgs: 'sg-a, sg-b ,sg-c', Csv: 'x,y', Plain: 'single' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn'
    );
    expect(ctx.params.Sgs).toEqual(['sg-a', 'sg-b', 'sg-c']);
    expect(ctx.params.Csv).toEqual(['x', 'y']);
    expect(ctx.params.Plain).toBe('single'); // a scalar SSM param is NOT split
  });

  it('does NOT seed a NoEcho parameter from its template Default (#744)', () => {
    // A NoEcho Default is a placeholder, not the deployed secret. Seeding it FPs every
    // property fed by the param and revert would overwrite the live secret; it must stay
    // out of ctx so a Ref resolves UNRESOLVED (deployed value is masked '****' and dropped).
    const template = {
      Parameters: {
        Secret: { Type: 'String', NoEcho: true, Default: 'changeme' },
        SecretStr: { Type: 'String', NoEcho: 'true', Default: 'changeme2' }, // NoEcho as string
        Plain: { Type: 'String', Default: 'kept' },
      },
    };
    const ctx = buildResolverContext(template, {}, {}, 'us-east-1', '999', 'S', 'arn');
    expect('Secret' in ctx.params).toBe(false); // NoEcho Default NOT seeded
    expect('SecretStr' in ctx.params).toBe(false);
    expect(ctx.params.Plain).toBe('kept'); // an ordinary Default is still seeded
  });
});

describe('parseTemplateBody', () => {
  it('parses JSON and YAML bodies', () => {
    expect(parseTemplateBody('{"Resources":{}}')).toEqual({ Resources: {} });
    expect(parseTemplateBody('Resources: {}')).toEqual({ Resources: {} });
  });
});

describe('loadDesired templateOverride (--pre-deploy)', () => {
  it('uses the override template as the declared source and skips GetTemplate', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Bucket',
          PhysicalResourceId: 'b-phys',
          ResourceType: 'AWS::S3::Bucket',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });

    const synthTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'from-synth' } } },
    };
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'S',
      'us-east-1',
      synthTemplate
    );
    expect(desired.resources).toHaveLength(1);
    expect(desired.resources[0]!.declared).toEqual({ BucketName: 'from-synth' });
    expect(desired.resources[0]!.physicalId).toBe('b-phys'); // physId still from live stack
    expect(desired.accountId).toBe('111122223333');
  });
});

describe('#883 — deletedResourceInfo (deploy-will-DELETE surface under --pre-deploy)', () => {
  it('lists deployed logical ids absent from the local template (a rename tears down the old one)', () => {
    // Rename X -> Y: the live stack still has OldBucket; the local template declares NewBucket.
    const physIds = { OldBucket: 'old-phys', Keep: 'keep-phys' };
    const template = {
      Resources: { NewBucket: { Type: 'AWS::S3::Bucket' }, Keep: { Type: 'AWS::S3::Bucket' } },
    };
    const line = deletedResourceInfo(physIds, template, 'S');
    expect(line).toBe(
      'info: S: 1 deployed resource(s) absent from the local template — the next deploy will DELETE them: OldBucket'
    );
  });

  it('returns null when every deployed resource is still in the template (nothing to delete)', () => {
    const physIds = { A: 'a', B: 'b' };
    const template = {
      Resources: { A: { Type: 'AWS::S3::Bucket' }, B: { Type: 'AWS::S3::Bucket' } },
    };
    expect(deletedResourceInfo(physIds, template, 'S')).toBeNull();
  });

  it('caps the listed ids at 10 with an overflow count', () => {
    const physIds: Record<string, string> = {};
    for (let i = 0; i < 12; i++) physIds[`R${String(i).padStart(2, '0')}`] = `p${i}`;
    const line = deletedResourceInfo(physIds, { Resources: {} }, 'S');
    expect(line).toContain('12 deployed resource(s) absent');
    expect(line).toContain('…(+2 more)');
  });
});

describe('#883 — loadDesired emits the deploy-will-DELETE note ONLY under --pre-deploy', () => {
  function stack(cfn: ReturnType<typeof mockClient>): void {
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'OldBucket',
          PhysicalResourceId: 'old-phys',
          ResourceType: 'AWS::S3::Bucket',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
  }

  it('under --pre-deploy, a deployed resource absent from the synth template is warned to stderr', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    stack(cfn);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    try {
      // synth template renamed OldBucket -> NewBucket
      await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
        Resources: { NewBucket: { Type: 'AWS::S3::Bucket' } },
      });
      // read BEFORE mockRestore(): mockRestore() resets .mock.calls.
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(msg).toContain('the next deploy will DELETE them: OldBucket');
  });

  it('on the NON-pre-deploy (deployed) path the note never fires (id sets always match)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: { NewBucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      }),
    });
    stack(cfn);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    try {
      // no templateOverride => deployed path
      await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1');
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(msg).not.toContain('the next deploy will DELETE');
  });
});

describe('loadDesired ListStackResources pagination', () => {
  it('pages NextToken and loads every resource (>100-resource stacks)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: {
          A: { Type: 'AWS::S3::Bucket', Properties: {} },
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      }),
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
    // page 1 -> NextToken, page 2 -> last page
    cfn
      .on(ListStackResourcesCommand, { StackName: 'S', NextToken: undefined })
      .resolves({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'A',
            PhysicalResourceId: 'a-phys',
            ResourceType: 'AWS::S3::Bucket',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
        NextToken: 'p2',
      })
      .on(ListStackResourcesCommand, { StackName: 'S', NextToken: 'p2' })
      .resolves({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'B',
            PhysicalResourceId: 'b-phys',
            ResourceType: 'AWS::S3::Bucket',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
      });

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1');
    const ids = Object.fromEntries(desired.resources.map((r) => [r.logicalId, r.physicalId]));
    expect(ids).toEqual({ A: 'a-phys', B: 'b-phys' }); // both pages loaded
  });
});

describe('loadDesired non-ASCII recovery (GetTemplate `?`-mask from local synth)', () => {
  function ssmStack(cfn: ReturnType<typeof mockClient>, maskedValue: string) {
    // GetTemplate returns the deployed body with the non-ASCII Value masked as `?`.
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: maskedValue } } },
      }),
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'P',
          PhysicalResourceId: '/p',
          ResourceType: 'AWS::SSM::Parameter',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
  }
  const valueOf = (d: Awaited<ReturnType<typeof loadDesired>>) =>
    (d.resources.find((r) => r.logicalId === 'P')?.declared as { Value?: unknown }).Value;

  it('recovers the masked declared value from the synth template when the mask matches', async () => {
    const cfn = mockClient(CloudFormationClient);
    ssmStack(cfn, '?????ABC');
    const synth = {
      Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'áéíóúABC' } } },
    };
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'S',
      'us-east-1',
      undefined,
      synth
    );
    expect(valueOf(desired)).toBe('áéíóúABC'); // recovered, ready for a real compare
  });

  it('leaves the mask in place (→ readGap downstream) when no synth recovery is given', async () => {
    const cfn = mockClient(CloudFormationClient);
    ssmStack(cfn, '?????ABC');
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1');
    expect(valueOf(desired)).toBe('?????ABC'); // unchanged → classify emits readGap
  });
});

describe('loadDesired Fn::ImportValue exports prefetch', () => {
  function stackMocks(cfn: ReturnType<typeof mockClient>, templateBody: string) {
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: templateBody });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Q',
          PhysicalResourceId: 'q-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/IV/x',
          StackName: 'IV',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
  }

  it('prefetches (paginated) + resolves Fn::ImportValue when the template references it', async () => {
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      JSON.stringify({
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: { 'Fn::ImportValue': 'SharedArn' } } },
        },
      })
    );
    cfn
      .on(ListExportsCommand, { NextToken: undefined })
      .resolves({ Exports: [{ Name: 'Other', Value: 'o' }], NextToken: 'e2' })
      .on(ListExportsCommand, { NextToken: 'e2' })
      .resolves({ Exports: [{ Name: 'SharedArn', Value: 'arn:aws:x:::shared' }] });

    // distinct region per test so the module-level exports cache can't cross-contaminate
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'IV',
      'ap-northeast-1'
    );
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'arn:aws:x:::shared' });
  });

  it('prefetches + resolves a YAML short-form !ImportValue (WAVE20)', async () => {
    // A YAML deployed template carries the short-form tag `!ImportValue`, never the
    // long-form string `Fn::ImportValue`. Gating the prefetch on the raw body missed it,
    // leaving the import UNRESOLVED (missed drift). The gate now reads the PARSED template.
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      [
        'Resources:',
        '  Q:',
        '    Type: AWS::SQS::Queue',
        '    Properties:',
        '      Tag: !ImportValue SharedArn',
      ].join('\n')
    );
    cfn
      .on(ListExportsCommand)
      .resolves({ Exports: [{ Name: 'SharedArn', Value: 'arn:aws:x:::shared' }] });

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'IV', 'us-west-2');
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'arn:aws:x:::shared' });
  });

  it('does NOT call ListExports when the template has no Fn::ImportValue', async () => {
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      JSON.stringify({
        Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: 'static' } } },
      })
    );
    cfn.on(ListExportsCommand).rejects(new Error('ListExports must NOT be called'));

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'IV', 'eu-west-1');
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'static' });
  });
});

describe('loadDesired stack parameter resolution', () => {
  function paramMocks(
    cfn: ReturnType<typeof mockClient>,
    parameters: Array<{ ParameterKey: string; ParameterValue?: string; ResolvedValue?: string }>
  ) {
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: { Ref: 'P' } } },
        },
      }),
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Q',
          PhysicalResourceId: 'q-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/P/x',
          StackName: 'P',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: parameters,
        },
      ],
    });
  }

  it('prefers ResolvedValue over ParameterValue for an SSM-typed parameter', async () => {
    // SSM-typed params (Type: AWS::SSM::Parameter::Value<String>) return the SSM KEY
    // in ParameterValue and the dereferenced value in ResolvedValue. Ref must resolve
    // to the deployed value, not the key, or a declared property Ref'ing it FPs.
    const cfn = mockClient(CloudFormationClient);
    paramMocks(cfn, [
      { ParameterKey: 'P', ParameterValue: '/my/ssm/key', ResolvedValue: 'real-value' },
    ]);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'P', 'us-east-1');
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'real-value' });
  });

  it('skips a NoEcho-masked **** parameter so its Ref resolves UNRESOLVED (not the mask)', async () => {
    // A NoEcho param is returned masked as '****'. Comparing against the mask is a
    // false positive; skipping the param leaves Ref UNRESOLVED → the property is
    // skipped (not compared), the same as an unresolvable dynamic reference.
    const cfn = mockClient(CloudFormationClient);
    paramMocks(cfn, [{ ParameterKey: 'P', ParameterValue: '****' }]);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'P', 'us-east-1');
    // Tag Ref'd a param that is no longer in ctx → resolves to the UNRESOLVED
    // symbol, which classify skips (never a '****' comparison / false drift).
    expect(desired.resources[0]!.declared).toEqual({ Tag: UNRESOLVED });
  });

  it('uses ParameterValue when there is no ResolvedValue (ordinary parameter)', async () => {
    const cfn = mockClient(CloudFormationClient);
    paramMocks(cfn, [{ ParameterKey: 'P', ParameterValue: 'plain' }]);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'P', 'us-east-1');
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'plain' });
  });
});

describe('loadDesired Ref AWS::NotificationARNs (#746)', () => {
  function notifMocks(cfn: ReturnType<typeof mockClient>, notificationArns?: string[]) {
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { Arns: { Ref: 'AWS::NotificationARNs' } } },
        },
      }),
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Q',
          PhysicalResourceId: 'q-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/N/x',
          StackName: 'N',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
          ...(notificationArns ? { NotificationARNs: notificationArns } : {}),
        },
      ],
    });
  }

  it('resolves Ref AWS::NotificationARNs to the DescribeStacks NotificationARNs list', async () => {
    const cfn = mockClient(CloudFormationClient);
    const arns = ['arn:aws:sns:us-east-1:111122223333:Topic1'];
    notifMocks(cfn, arns);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'N', 'us-east-1');
    expect(desired.resources[0]!.declared).toEqual({ Arns: arns });
  });

  it('leaves Ref AWS::NotificationARNs UNRESOLVED when the stack has none', async () => {
    const cfn = mockClient(CloudFormationClient);
    notifMocks(cfn, undefined);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'N', 'us-east-1');
    expect(desired.resources[0]!.declared).toEqual({ Arns: UNRESOLVED });
  });
});

describe('loadDesired resource-level Condition (#689)', () => {
  // A resource guarded by a Condition that evaluates FALSE is never created, so it has
  // no physical id and no live counterpart. It must be DROPPED from the desired set —
  // not pushed through to classifyRead where it becomes a permanent
  // `skipped: no physical id` (false "coverage incomplete" noise; keeps --strict red).
  function condStack(
    cfn: ReturnType<typeof mockClient>,
    envValue: string,
    resourceSummaries: Array<{ LogicalResourceId: string; PhysicalResourceId: string }>
  ) {
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Parameters: { Env: { Type: 'String', Default: 'dev' } },
        Conditions: {
          ProdCond: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] }, // false when Env=dev
          DevCond: { 'Fn::Equals': [{ Ref: 'Env' }, 'dev'] }, // true when Env=dev
          UnkCond: { 'Fn::Equals': [{ Ref: 'Nonexistent' }, 'x'] }, // UNRESOLVED
        },
        Resources: {
          ProdOnly: { Type: 'AWS::SNS::Topic', Condition: 'ProdCond' }, // false → drop
          DevOnly: { Type: 'AWS::SNS::Topic', Condition: 'DevCond' }, // true → keep
          Unk: { Type: 'AWS::SNS::Topic', Condition: 'UnkCond' }, // unresolved → keep
          Always: { Type: 'AWS::SNS::Topic' }, // no condition → keep
          // A condition-FALSE resource that somehow HAS a physical id (a CFn anomaly)
          // must still surface — the fold is gated on "false AND no physical id".
          AnomalyFalse: { Type: 'AWS::SNS::Topic', Condition: 'ProdCond' },
        },
      }),
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: resourceSummaries.map((s) => ({
        LogicalResourceId: s.LogicalResourceId,
        PhysicalResourceId: s.PhysicalResourceId,
        ResourceType: 'AWS::SNS::Topic',
        LastUpdatedTimestamp: new Date(0),
        ResourceStatus: 'CREATE_COMPLETE',
      })),
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/C/x',
          StackName: 'C',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [{ ParameterKey: 'Env', ParameterValue: envValue }],
        },
      ],
    });
  }

  it('drops a condition-FALSE resource with no physical id; keeps true/unresolved/unconditioned', async () => {
    const cfn = mockClient(CloudFormationClient);
    condStack(cfn, 'dev', [
      { LogicalResourceId: 'DevOnly', PhysicalResourceId: 'arn:dev' },
      { LogicalResourceId: 'Always', PhysicalResourceId: 'arn:always' },
      // Anomaly: a condition-false resource that nonetheless has a physical id.
      { LogicalResourceId: 'AnomalyFalse', PhysicalResourceId: 'arn:anomaly' },
    ]);
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'C', 'us-east-1');
    const ids = desired.resources.map((r) => r.logicalId).sort();
    // ProdOnly (condition false, no physical id) is dropped; everything else survives.
    expect(ids).toEqual(['Always', 'AnomalyFalse', 'DevOnly', 'Unk']);
  });
});

describe('#882 — typeChangedResources / typeChangeReplaceInfo (pure)', () => {
  it('flags a logical id whose declared Type differs from the deployed Type', () => {
    const template = { X: { Type: 'AWS::SNS::Topic' }, Keep: { Type: 'AWS::S3::Bucket' } };
    const deployed = { X: 'AWS::SQS::Queue', Keep: 'AWS::S3::Bucket' };
    expect(typeChangedResources(template, deployed)).toEqual(['X']); // Queue -> Topic
  });

  it('does NOT flag a brand-new logical id absent from the deployed stack (a normal create)', () => {
    const template = { New: { Type: 'AWS::SNS::Topic' } };
    const deployed = {}; // New not deployed yet
    expect(typeChangedResources(template, deployed)).toEqual([]);
  });

  it('does NOT flag a logical id with the same Type on both sides', () => {
    const template = { Same: { Type: 'AWS::S3::Bucket' } };
    const deployed = { Same: 'AWS::S3::Bucket' };
    expect(typeChangedResources(template, deployed)).toEqual([]);
  });

  it('builds a "will REPLACE" note showing old -> new types, capped at 10', () => {
    const template: Record<string, { Type?: string }> = {};
    const deployed: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      template[`R${String(i).padStart(2, '0')}`] = { Type: 'AWS::SNS::Topic' };
      deployed[`R${String(i).padStart(2, '0')}`] = 'AWS::SQS::Queue';
    }
    const changed = typeChangedResources(template, deployed);
    const line = typeChangeReplaceInfo(changed, template, deployed, 'S')!;
    expect(line).toContain('12 resource(s) changed Type');
    expect(line).toContain('AWS::SQS::Queue -> AWS::SNS::Topic');
    expect(line).toContain('…(+2 more)');
  });

  it('returns null when nothing changed type', () => {
    expect(typeChangeReplaceInfo([], {}, {}, 'S')).toBeNull();
  });
});

describe('#882 — loadDesired same-logical-id Type change under --pre-deploy', () => {
  function typeSwapStack(cfn: ReturnType<typeof mockClient>): void {
    // Deployed stack has X as an SQS Queue with a real physical id.
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'X',
          PhysicalResourceId: 'https://sqs.us-east-1.amazonaws.com/111122223333/old-queue',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
  }

  it('withholds the deployed phys id when the local template swaps the type at the same id', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    typeSwapStack(cfn);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    let physicalId: string | undefined;
    try {
      // local synth swapped X from a Queue to a Topic (same logical id, new Type)
      const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
        Resources: { X: { Type: 'AWS::SNS::Topic', Properties: {} } },
      });
      physicalId = desired.resources.find((r) => r.logicalId === 'X')?.physicalId;
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    // The stale Queue phys id is NOT attached (would GetResource as a Topic → false deletion).
    expect(physicalId).toBeUndefined();
    // Instead the user is told the deploy will REPLACE it.
    expect(msg).toContain('changed Type at the same logical id — the next deploy will REPLACE');
    expect(msg).toContain('AWS::SQS::Queue -> AWS::SNS::Topic');
  });

  it('KEEPS the phys id when the type is unchanged (no false replace)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    typeSwapStack(cfn);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let physicalId: string | undefined;
    let msg = '';
    try {
      // same type as deployed → phys id kept, no replace note
      const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
        Resources: { X: { Type: 'AWS::SQS::Queue', Properties: {} } },
      });
      physicalId = desired.resources.find((r) => r.logicalId === 'X')?.physicalId;
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(physicalId).toBe('https://sqs.us-east-1.amazonaws.com/111122223333/old-queue');
    expect(msg).not.toContain('changed Type');
  });
});

describe('#882 — loadDesired stack-state gate under --pre-deploy', () => {
  function stateStack(cfn: ReturnType<typeof mockClient>, status: StackStatus): void {
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    cfn.on(ListStackResourcesCommand).resolves({ StackResourceSummaries: [] });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: status,
          Parameters: [],
        },
      ],
    });
  }

  it('SKIPS (throws StackNotCheckableError) a DELETE_IN_PROGRESS stack even under --pre-deploy', async () => {
    const cfn = mockClient(CloudFormationClient);
    stateStack(cfn, 'DELETE_IN_PROGRESS');
    await expect(
      loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
        Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
      })
    ).rejects.toBeInstanceOf(StackNotCheckableError);
  });

  it('WARNS (stackStatusWarning) for a mid-operation stack even under --pre-deploy', async () => {
    const cfn = mockClient(CloudFormationClient);
    stateStack(cfn, 'UPDATE_IN_PROGRESS');
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
      Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    expect(desired.stackStatusWarning).toContain('mid-operation');
  });

  it('stays OK (no warning) for a stable CREATE_COMPLETE stack under --pre-deploy', async () => {
    const cfn = mockClient(CloudFormationClient);
    stateStack(cfn, 'CREATE_COMPLETE');
    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', {
      Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    expect(desired.stackStatusWarning).toBeUndefined();
  });
});

describe('#882 — buildResolverContext does NOT seed an SSM-typed param Default (resolves UNRESOLVED)', () => {
  it('skips the SSM KEY Default of a NEW SSM-typed param so Ref does not resolve to the key', () => {
    // A new local `Type: AWS::SSM::Parameter::Value<String>` param with Default '/golden/ami'
    // has no deployed ResolvedValue. Seeding its Default would make Ref resolve to the KEY
    // string, not the live AMI id — a fabricated declared FP. It must stay out of ctx.
    const template = {
      Parameters: {
        Ami: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/golden/ami' },
        Plain: { Type: 'String', Default: 'kept' },
      },
    };
    const ctx = buildResolverContext(template, {}, {}, 'us-east-1', '999', 'S', 'arn');
    expect('Ami' in ctx.params).toBe(false); // SSM-typed Default NOT seeded (would be the key)
    expect(ctx.params.Plain).toBe('kept'); // an ordinary Default is still seeded
  });

  it('a deployed ResolvedValue still WINS for an SSM-typed param (existing param)', () => {
    // When the param IS deployed, the DescribeStacks ResolvedValue is passed in stackParams
    // and overrides — the fix only withholds the KEY-string Default, never the real value.
    const template = {
      Parameters: { Ami: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/golden/ami' } },
    };
    const ctx = buildResolverContext(
      template,
      { Ami: 'ami-0abc123' }, // deployed ResolvedValue (loadDesired prefers ResolvedValue)
      {},
      'us-east-1',
      '999',
      'S',
      'arn'
    );
    expect(ctx.params.Ami).toBe('ami-0abc123'); // real deployed value, not the key
  });

  it('an SSM LIST-typed Default is likewise withheld (would be the key, not the values)', () => {
    const template = {
      Parameters: {
        Sgs: {
          Type: 'AWS::SSM::Parameter::Value<List<AWS::EC2::SecurityGroup::Id>>',
          Default: '/my/sgs',
        },
      },
    };
    const ctx = buildResolverContext(template, {}, {}, 'us-east-1', '999', 'S', 'arn');
    expect('Sgs' in ctx.params).toBe(false);
  });
});

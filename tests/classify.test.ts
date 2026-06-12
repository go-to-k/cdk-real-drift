import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

function tiers(findings: Finding[]) {
  const by = (t: string) =>
    findings
      .filter((f) => f.tier === t)
      .map((f) => f.path)
      .sort();
  return {
    declared: by('declared'),
    undeclared: by('undeclared'),
    readGap: by('readGap'),
    unresolved: by('unresolved'),
  };
}

describe('classifyResource (the heart)', () => {
  const schema: SchemaInfo = {
    readOnly: new Set(['Arn', 'RoleId']),
    writeOnly: new Set(['AssumeRolePolicyDocument']),
    createOnly: new Set(),
    readOnlyPaths: ['Arn', 'RoleId'],
    writeOnlyPaths: ['AssumeRolePolicyDocument'],
    createOnlyPaths: [],
    defaults: {},
  };
  const resource: DesiredResource = {
    logicalId: 'Role',
    resourceType: 'AWS::IAM::Role',
    physicalId: 'my-role-phys',
    declared: {
      ManagedPolicyArns: ['arnA'], // will drift
      Description: 'hi', // matches live → no drift
      MissingFromLive: 'x', // → readGap
      ComputedArn: UNRESOLVED, // → unresolved
      AssumeRolePolicyDocument: { Version: '1' }, // writeOnly → ignored
    },
  };
  const liveRaw: Record<string, unknown> = {
    ManagedPolicyArns: ['arnB'],
    Description: 'hi',
    MaxSessionDuration: 3600, // known default → suppressed
    Path: '/', // known default → suppressed
    GuardrailPolicies: ['arn:aws:iam::aws:policy/AdministratorAccess'], // ★ undeclared signal
    SelfName: 'my-role-phys', // == physicalId → suppressed
    EmptyList: [], // trivial empty → suppressed
    Tags: [{ Key: 'aws:cloudformation:stack-id', Value: 'x' }], // aws:* → suppressed
    Arn: 'arn:...', // readOnly → stripped
    RoleId: 'AID', // readOnly → stripped
    CreationDate: '2020', // managed → stripped
  };

  it('classifies declared / undeclared / readGap / unresolved correctly', () => {
    const t = tiers(classifyResource(resource, liveRaw, schema));
    expect(t.declared).toEqual(['ManagedPolicyArns']);
    expect(t.undeclared).toEqual(['GuardrailPolicies']); // only the real signal survives noise subtraction
    // R11: a declared write-only key (AssumeRolePolicyDocument) is now surfaced as a
    // readGap instead of being silently dropped, alongside the absent-from-live key.
    expect(t.readGap).toEqual(['AssumeRolePolicyDocument', 'MissingFromLive']);
    expect(t.unresolved).toEqual(['ComputedArn']);
  });

  it('declared drift carries desired + actual values', () => {
    const drift = classifyResource(resource, liveRaw, schema).find((f) => f.tier === 'declared')!;
    expect(drift.desired).toEqual(['arnA']);
    expect(drift.actual).toEqual(['arnB']);
  });

  // R11: a declared top-level write-only key surfaces as exactly one readGap finding
  // and is NEVER compared as declared/undeclared drift.
  it('write-only declared key -> exactly one readGap (write-only note), never compared', () => {
    const findings = classifyResource(resource, liveRaw, schema);
    const writeOnlyGaps = findings.filter(
      (f) => f.tier === 'readGap' && f.path === 'AssumeRolePolicyDocument'
    );
    expect(writeOnlyGaps).toHaveLength(1);
    expect(writeOnlyGaps[0].note).toContain('write-only');
    // never leaks into declared/undeclared tiers
    expect(
      findings.some(
        (f) =>
          f.path === 'AssumeRolePolicyDocument' &&
          (f.tier === 'declared' || f.tier === 'undeclared')
      )
    ).toBe(false);
  });
});

// R10: classifyResource threads optional { accountId, region } into isArnNameMatch.
describe('classifyResource account/region-scoped ARN identity (R10)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
  };
  const res: DesiredResource = {
    logicalId: 'Fn',
    resourceType: 'AWS::Lambda::Function',
    physicalId: 'p',
    declared: { FunctionName: 'MyFn' },
  };
  const declaredPaths = (
    live: Record<string, unknown>,
    opts?: { accountId?: string; region?: string }
  ) =>
    classifyResource(res, live, bare, opts)
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  const opts = { accountId: '111122223333', region: 'us-east-1' };
  it('same account+region ARN is suppressed (regression)', () => {
    const live = { FunctionName: 'arn:aws:lambda:us-east-1:111122223333:function:MyFn' };
    expect(declaredPaths(live, opts)).toEqual([]);
  });
  it('different account ARN is reported as drift', () => {
    const live = { FunctionName: 'arn:aws:lambda:us-east-1:999999999999:function:MyFn' };
    expect(declaredPaths(live, opts)).toEqual(['FunctionName']);
  });
  it('different region ARN is reported as drift', () => {
    const live = { FunctionName: 'arn:aws:lambda:eu-west-1:111122223333:function:MyFn' };
    expect(declaredPaths(live, opts)).toEqual(['FunctionName']);
  });
  it('without opts, behavior is unchanged (suffix-only suppression)', () => {
    const live = { FunctionName: 'arn:aws:lambda:eu-west-1:999999999999:function:MyFn' };
    expect(declaredPaths(live)).toEqual([]);
  });
});

// End-to-end regression for the four false-declared-drift classes found by
// dogfooding real cdkd fixtures (vpc-lambda / sns-sqs / rds). Each pair proves the
// noise is suppressed AND that a genuine change on the same property still surfaces.
describe('classifyResource regressions (dogfood false-positive classes)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
  };
  const res = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'R',
    resourceType: 'AWS::EC2::Subnet',
    physicalId: 'p',
    declared,
  });
  const declaredPaths = (d: Record<string, unknown>, live: Record<string, unknown>) =>
    classifyResource(res(d), live, bare)
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  it('tag-list order is not drift; a changed tag value is', () => {
    const a = [
      { Key: 'Name', Value: 'n' },
      { Key: 'aws-cdk:subnet-type', Value: 'Public' },
    ];
    const reordered = [
      { Key: 'aws-cdk:subnet-type', Value: 'Public' },
      { Key: 'Name', Value: 'n' },
    ];
    expect(declaredPaths({ Tags: a }, { Tags: reordered })).toEqual([]);
    const changed = [
      { Key: 'aws-cdk:subnet-type', Value: 'Private' }, // value changed
      { Key: 'Name', Value: 'n' },
    ];
    expect(declaredPaths({ Tags: a }, { Tags: changed }).length).toBeGreaterThan(0);
  });

  it('resource-id array order is not drift; a changed id is', () => {
    const d = { SubnetIds: ['subnet-0fb5ef44aa', 'subnet-0daf2ccbbb'] };
    expect(declaredPaths(d, { SubnetIds: ['subnet-0daf2ccbbb', 'subnet-0fb5ef44aa'] })).toEqual([]);
    expect(
      declaredPaths(d, { SubnetIds: ['subnet-0daf2ccbbb', 'subnet-09999999cc'] }).length
    ).toBeGreaterThan(0);
  });

  it('declared bare name vs live ARN is not drift; a different name is', () => {
    const d = { FunctionName: 'MyFn' };
    expect(declaredPaths(d, { FunctionName: 'arn:aws:lambda:us-east-1:1:function:MyFn' })).toEqual(
      []
    );
    expect(
      declaredPaths(d, { FunctionName: 'arn:aws:lambda:us-east-1:1:function:OtherFn' }).length
    ).toBeGreaterThan(0);
  });

  it('managed-default KMS alias vs resolved key ARN is not drift; a custom alias is', () => {
    const arn = 'arn:aws:kms:us-east-1:1:key/9ee8feba-ae18-445a-bcab-306f7748fb6c';
    expect(declaredPaths({ KmsKeyId: 'alias/aws/rds' }, { KmsKeyId: arn })).toEqual([]);
    // a custom alias resolving to that key IS reported (we only collapse alias/aws/*)
    expect(declaredPaths({ KmsKeyId: 'alias/my-key' }, { KmsKeyId: arn }).length).toBeGreaterThan(
      0
    );
  });
});

describe('classifyResource post-revert phantom drift (R46)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
  };
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'R',
    resourceType,
    physicalId: 'p',
    declared,
  });
  const undeclaredPaths = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    classifyResource(res(resourceType, declared), live, bare)
      .filter((f) => f.tier === 'undeclared')
      .map((f) => f.path);

  it('the empty VpcConfig struct a CC update materializes on a Lambda is not drift', () => {
    const emptyVpc = { Ipv6AllowedForDualStack: false, SecurityGroupIds: [], SubnetIds: [] };
    expect(undeclaredPaths('AWS::Lambda::Function', {}, { VpcConfig: emptyVpc })).toEqual([]);
    // a REAL out-of-band VPC attachment is still reported
    expect(
      undeclaredPaths(
        'AWS::Lambda::Function',
        {},
        { VpcConfig: { ...emptyVpc, SubnetIds: ['subnet-0aaa111bbb'] } }
      )
    ).toEqual(['VpcConfig']);
  });

  it('undeclared S3 versioning: Suspended (the post-revert off state) is not drift; Enabled is', () => {
    expect(
      undeclaredPaths('AWS::S3::Bucket', {}, { VersioningConfiguration: { Status: 'Suspended' } })
    ).toEqual([]);
    expect(
      undeclaredPaths('AWS::S3::Bucket', {}, { VersioningConfiguration: { Status: 'Enabled' } })
    ).toEqual(['VersioningConfiguration']);
  });

  it('DECLARED Enabled vs live Suspended stays declared drift (KNOWN_DEFAULTS never touches the declared loop)', () => {
    const findings = classifyResource(
      res('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } }),
      { VersioningConfiguration: { Status: 'Suspended' } },
      bare
    );
    expect(findings.filter((f) => f.tier === 'declared').map((f) => f.path)).toEqual([
      'VersioningConfiguration.Status',
    ]);
  });
});

describe('sibling-managed inline Policies (IAM Role)', () => {
  const noSchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
  };
  const DOC = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
  };
  const sibling = { PolicyName: 'RoleDefaultPolicyABC', PolicyDocument: DOC };
  const rogue = { PolicyName: 'rogue-inline', PolicyDocument: DOC };
  const role = (
    siblingPolicyNames?: string[] | 'unresolved',
    declared: Record<string, unknown> = {}
  ): DesiredResource => ({
    logicalId: 'Role',
    resourceType: 'AWS::IAM::Role',
    physicalId: 'role-name',
    declared,
    siblingPolicyNames,
  });

  it('a live Policies entry owned by a sibling is filtered out (no finding)', () => {
    const findings = classifyResource(
      role(['RoleDefaultPolicyABC']),
      { Policies: [sibling] },
      noSchema
    );
    expect(findings).toEqual([]);
  });

  it('an out-of-band inline policy NEXT TO a sibling surfaces as undeclared with ONLY the rogue entry', () => {
    const findings = classifyResource(
      role(['RoleDefaultPolicyABC']),
      { Policies: [sibling, rogue] },
      noSchema
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tier: 'undeclared', path: 'Policies' });
    const actual = findings[0]!.actual as { PolicyName: string }[];
    expect(actual.map((p) => p.PolicyName)).toEqual(['rogue-inline']);
  });

  it('with NO sibling, every live inline policy is undeclared (unchanged behavior)', () => {
    const findings = classifyResource(role(undefined), { Policies: [rogue] }, noSchema);
    expect(tiers(findings).undeclared).toEqual(['Policies']);
  });

  it("'unresolved' sibling names fall back to suppressing the whole property", () => {
    const findings = classifyResource(role('unresolved'), { Policies: [sibling, rogue] }, noSchema);
    expect(findings).toEqual([]);
  });

  it('declared role Policies + sibling entries in live: the sibling entry is not false declared drift', () => {
    const declared = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] };
    const live = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }, sibling] };
    const findings = classifyResource(role(['RoleDefaultPolicyABC'], declared), live, noSchema);
    expect(findings).toEqual([]);
  });
});

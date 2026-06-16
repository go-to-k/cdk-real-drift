import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, normalizeLiveModel } from '../src/diff/classify.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import { KNOWN_DEFAULT_PATHS, KNOWN_DEFAULTS } from '../src/normalize/noise.js';
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
    atDefault: by('atDefault'),
    generated: by('generated'),
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
    defaultPaths: {},
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

  // R23: a CFn stringly-typed scalar ARRAY (declared [80, 443] vs live ["80","443"])
  // surfaces from the drift-calculator as one parent-path record carrying the whole
  // array; the per-leaf stringly check could not see the elements. Now suppressed.
  it('stringly-typed scalar array is not declared drift, real element change still is (R23)', () => {
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
    const res: DesiredResource = {
      logicalId: 'LB',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      physicalId: 'lb-phys',
      declared: { Ports: [80, 443], Flags: [true, false] },
    };
    // AWS echoes the typed list as strings, same order — no declared drift.
    const clean = tiers(
      classifyResource(res, { Ports: ['80', '443'], Flags: ['true', 'false'] }, emptySchema)
    );
    expect(clean.declared).toEqual([]);
    // A genuine element change still surfaces as declared drift.
    const drifted = tiers(
      classifyResource(res, { Ports: ['80', '8443'], Flags: ['true', 'false'] }, emptySchema)
    );
    expect(drifted.declared).toEqual(['Ports']);
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
    defaultPaths: {},
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
    defaultPaths: {},
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

  it('PEM EncodedKey trailing-newline round-trip is not drift; a changed key is (R125)', () => {
    // CloudFront PublicKey: the declared PEM has no trailing newline, but
    // GetPublicKey returns the same body with one appended after the END marker.
    const pem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqAQAB\n-----END PUBLIC KEY-----';
    const d = { PublicKeyConfig: { EncodedKey: pem } };
    expect(declaredPaths(d, { PublicKeyConfig: { EncodedKey: `${pem}\n` } })).toEqual([]);
    const other = '-----BEGIN PUBLIC KEY-----\nMIIBIjANDIFFERENT\n-----END PUBLIC KEY-----';
    expect(declaredPaths(d, { PublicKeyConfig: { EncodedKey: other } }).length).toBeGreaterThan(0);
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
    defaultPaths: {},
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

  it('DECLARED Enabled vs live Suspended stays declared drift (KNOWN_DEFAULTS never mutes a non-empty declared value)', () => {
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
    defaultPaths: {},
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

  it("'unresolved' sibling names FAIL OPEN: live Policies surface (a rogue policy is never hidden) (R111)", () => {
    // the old behavior deleted the whole property, which also hid an out-of-band
    // inline policy on the role — a silent false negative. Now the Policies surface
    // as undeclared (the sibling-managed entries are baseline-able once, but the
    // rogue one is reported), so a security-relevant change is never dropped.
    const findings = classifyResource(role('unresolved'), { Policies: [sibling, rogue] }, noSchema);
    expect(tiers(findings).undeclared).toEqual(['Policies']);
    const f = findings.find((x) => x.path === 'Policies')!;
    // the rogue entry must be present in the surfaced value
    expect(JSON.stringify(f.actual)).toContain('rogue');
  });

  it('declared role Policies + sibling entries in live: the sibling entry is not false declared drift', () => {
    const declared = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] };
    const live = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }, sibling] };
    const findings = classifyResource(role(['RoleDefaultPolicyABC'], declared), live, noSchema);
    expect(findings).toEqual([]);
  });

  it('a live-only sub-key added to a WRAPPED inline-policy statement surfaces as undeclared (WAVE20 F3)', () => {
    // The dominant CDK shape: `Policies: [{ PolicyName, PolicyDocument: { Statement } }]`.
    // The wrapper array is identity-less and its elements aren't statements, so before
    // the fix the statement subset-descent (#151, top-level docs only) never reached the
    // wrapped statement — an out-of-band `Condition` on an inline role policy was invisible.
    const declared = {
      Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }],
    };
    const live = {
      Policies: [
        {
          PolicyName: 'inline-a',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: 's3:GetObject',
                Resource: '*',
                Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-rogue' } },
              },
            ],
          },
        },
      ],
    };
    const findings = classifyResource(role([], declared), live, noSchema);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tier: 'undeclared',
      path: 'Policies[inline-a].PolicyDocument.Statement[0].Condition',
    });
    // an identical declared/live inline policy emits nothing (no FP)
    const clean = classifyResource(
      role([], { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] }),
      { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] },
      noSchema
    );
    expect(clean).toEqual([]);
  });

  it('a property containing one UNRESOLVED sub-value still surfaces a genuinely undeclared sibling sub-key (WAVE20 F2)', () => {
    // Before: a property with ANY unresolved sub-value was skipped WHOLE for nested
    // descent, hiding live-only undeclared keys under config-bag properties that merely
    // reference another resource. Now only the unresolved SUBTREE is inert.
    const declared = { Cfg: { Known: UNRESOLVED, Other: 'x' } };
    const live = { Cfg: { Known: 'live-val', Other: 'x', LIVE_ONLY: 'rogue' } };
    const r: DesiredResource = {
      logicalId: 'R',
      resourceType: 'AWS::Foo::Bar',
      physicalId: 'p',
      declared,
    };
    const findings = classifyResource(r, live, noSchema);
    // the property is still flagged `unresolved` (partial unresolution noted)...
    expect(tiers(findings).unresolved).toEqual(['Cfg']);
    // ...AND the live-only undeclared sibling is now surfaced (previously hidden)
    const u = findings.find((f) => f.tier === 'undeclared');
    expect(u).toMatchObject({ path: 'Cfg.LIVE_ONLY', actual: 'rogue' });
  });
});

describe('KNOWN_DEFAULTS suppression (R66 — dogfood-observed service defaults)', () => {
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
  const bare = (resourceType: string): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared: {},
  });

  it('EVERY entry FOLDS its exact default value to the atDefault tier (R86), never to drift', () => {
    // generic: each (type, key, default) must classify to a single atDefault finding
    // (folded inventory, not drift) — this also catches a canonicalization step
    // mangling the listed default shape (which would resurface it as undeclared).
    for (const [resourceType, defs] of Object.entries(KNOWN_DEFAULTS)) {
      for (const [key, value] of Object.entries(defs)) {
        const findings = classifyResource(
          bare(resourceType),
          { [key]: structuredClone(value) },
          emptySchema
        );
        expect(findings, `${resourceType}.${key}`).toHaveLength(1);
        expect(findings[0], `${resourceType}.${key}`).toMatchObject({
          tier: 'atDefault',
          path: key,
        });
      }
    }
  });

  it('a NON-default value for a listed key still surfaces (equality-gated)', () => {
    expect(
      tiers(
        classifyResource(
          bare('AWS::Lambda::Function'),
          { TracingConfig: { Mode: 'Active' } },
          emptySchema
        )
      ).undeclared
    ).toEqual(['TracingConfig']);
    expect(
      tiers(
        classifyResource(
          bare('AWS::Chatbot::SlackChannelConfiguration'),
          { GuardrailPolicies: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
          emptySchema
        )
      ).undeclared
    ).toEqual(['GuardrailPolicies']);
  });

  it('R104: an SQS default value folds; a changed one surfaces', () => {
    const t = (live: Record<string, unknown>) =>
      tiers(classifyResource(bare('AWS::SQS::Queue'), live, emptySchema));
    expect(t({ VisibilityTimeout: 30 }).atDefault).toEqual(['VisibilityTimeout']);
    expect(t({ VisibilityTimeout: 60 }).undeclared).toEqual(['VisibilityTimeout']);
  });

  it('R104: StateMachineType STANDARD folds, EXPRESS stays undeclared (equality-gated curation)', () => {
    const t = (v: string) =>
      tiers(
        classifyResource(
          bare('AWS::StepFunctions::StateMachine'),
          { StateMachineType: v },
          emptySchema
        )
      );
    expect(t('STANDARD').atDefault).toEqual(['StateMachineType']);
    expect(t('EXPRESS').undeclared).toEqual(['StateMachineType']);
  });

  it('R105: DynamoDB BillingMode PROVISIONED folds, PAY_PER_REQUEST surfaces', () => {
    const t = (v: string) =>
      tiers(classifyResource(bare('AWS::DynamoDB::Table'), { BillingMode: v }, emptySchema));
    expect(t('PROVISIONED').atDefault).toEqual(['BillingMode']);
    expect(t('PAY_PER_REQUEST').undeclared).toEqual(['BillingMode']);
  });

  // R74: the declared loop's trivially-empty rule — CDK Trail synthesizes
  // `EventSelectors: []`, CloudTrail materializes the default management
  // selector; that pair must not be drift, but everything around it must stay.
  describe('declared trivially-empty vs known service default (R74)', () => {
    const DEFAULT_SELECTOR = {
      IncludeManagementEvents: true,
      ReadWriteType: 'All',
      ExcludeManagementEventSources: [],
      DataResources: [],
    };
    const trail = (declared: Record<string, unknown>): DesiredResource => ({
      logicalId: 'Audit',
      resourceType: 'AWS::CloudTrail::Trail',
      physicalId: 'trail-name',
      declared,
    });

    it('declared [] vs the live default selector is NOT drift', () => {
      const findings = classifyResource(
        trail({ EventSelectors: [] }),
        { EventSelectors: [structuredClone(DEFAULT_SELECTOR)] },
        emptySchema
      );
      expect(findings).toEqual([]);
    });

    it('declared [] vs a MODIFIED selector is still declared drift (equality gate)', () => {
      const findings = classifyResource(
        trail({ EventSelectors: [] }),
        { EventSelectors: [{ ...structuredClone(DEFAULT_SELECTOR), ReadWriteType: 'ReadOnly' }] },
        emptySchema
      );
      expect(tiers(findings).declared).toEqual(['EventSelectors']);
    });

    it('a NON-empty declared value differing from live is never muted by the rule', () => {
      const findings = classifyResource(
        trail({ EventSelectors: [{ ReadWriteType: 'ReadOnly', IncludeManagementEvents: true }] }),
        { EventSelectors: [structuredClone(DEFAULT_SELECTOR)] },
        emptySchema
      );
      expect(tiers(findings).declared).toEqual(['EventSelectors.0.ReadWriteType']);
    });

    it('UNORDERED_ARRAY_PROPS: same OAuth enum set in a different order is NOT drift', () => {
      const client = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'WebClient',
        resourceType: 'AWS::Cognito::UserPoolClient',
        physicalId: 'client123',
        declared,
      });
      expect(
        classifyResource(
          client({ ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'] }),
          { ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'] },
          emptySchema
        )
      ).toEqual([]);
      // a genuine element change still reports
      expect(
        tiers(
          classifyResource(
            client({ ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'] }),
            { ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH'] },
            emptySchema
          )
        ).declared
      ).toEqual(['ExplicitAuthFlows']);
      // the rule is per-type+per-prop: the same shape on an UNLISTED prop still reports
      expect(
        tiers(
          classifyResource(
            client({ CallbackURLs: ['https://b.example', 'https://a.example'] }),
            { CallbackURLs: ['https://a.example', 'https://b.example'] },
            emptySchema
          )
        ).declared
      ).toEqual(['CallbackURLs']);
    });

    it('UNORDERED_ARRAY_PROPS: WAFv2 IPSet Addresses in a different order is NOT drift (R84)', () => {
      const ipset = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'IpSet',
        resourceType: 'AWS::WAFv2::IPSet',
        physicalId: 'ipset-1',
        declared,
      });
      // same CIDR set, reversed order — WAFv2 echoes its own canonical order
      expect(
        classifyResource(
          ipset({ Addresses: ['192.0.2.0/24', '198.51.100.0/24'] }),
          { Addresses: ['198.51.100.0/24', '192.0.2.0/24'] },
          emptySchema
        )
      ).toEqual([]);
      // a genuine CIDR change still reports
      expect(
        tiers(
          classifyResource(
            ipset({ Addresses: ['192.0.2.0/24', '198.51.100.0/24'] }),
            { Addresses: ['203.0.113.0/24', '192.0.2.0/24'] },
            emptySchema
          )
        ).declared
      ).toEqual(['Addresses']);
    });

    it('undeclared EventSelectors equal to the default folds to atDefault; a changed one surfaces', () => {
      expect(
        tiers(
          classifyResource(
            trail({}),
            { EventSelectors: [structuredClone(DEFAULT_SELECTOR)] },
            emptySchema
          )
        ).atDefault
      ).toEqual(['EventSelectors']);
      expect(
        tiers(
          classifyResource(
            trail({}),
            {
              EventSelectors: [
                { ...structuredClone(DEFAULT_SELECTOR), ReadWriteType: 'WriteOnly' },
              ],
            },
            emptySchema
          )
        ).undeclared
      ).toEqual(['EventSelectors']);
    });
  });
});

describe('declared-compare false-positive classes from harvest4 (R75)', () => {
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
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared,
  });

  describe('identity-keyed attribute bag subset (ELB)', () => {
    const T = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
    const declared = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ],
    };
    // AWS returns ~15 attributes; the template declared 2.
    const liveAll = [
      { Key: 'access_logs.s3.enabled', Value: 'false' },
      { Key: 'idle_timeout.timeout_seconds', Value: '120' },
      { Key: 'routing.http2.enabled', Value: 'true' },
      { Key: 'deletion_protection.enabled', Value: 'false' },
      { Key: 'client_keep_alive.seconds', Value: '3600' },
    ];

    it('a fresh deploy with extra live attributes is NOT drift (subset compared)', () => {
      expect(
        classifyResource(res(T, declared), { LoadBalancerAttributes: liveAll }, emptySchema)
      ).toEqual([]);
    });

    it('a genuine change to a DECLARED attribute still surfaces, named by Key (R78)', () => {
      const drifted = liveAll.map((a) =>
        a.Key === 'idle_timeout.timeout_seconds' ? { ...a, Value: '300' } : a
      );
      const findings = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: drifted },
        emptySchema
      );
      const declaredF = findings.filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      // R78: path stays at the bag property; the Key rides on attributeKey so
      // revert can send only this Key=Value (not an array-index Cloud Control patch).
      expect(declaredF[0]).toMatchObject({
        path: 'LoadBalancerAttributes',
        attributeKey: 'idle_timeout.timeout_seconds',
        desired: '120',
        actual: '300',
      });
    });

    it('R78: each changed attribute is its OWN finding (Key-scoped)', () => {
      const drifted = liveAll.map((a) =>
        a.Key === 'idle_timeout.timeout_seconds'
          ? { ...a, Value: '300' }
          : a.Key === 'deletion_protection.enabled'
            ? { ...a, Value: 'true' }
            : a
      );
      const declaredF = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: drifted },
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(
        declaredF.map((f) => f.attributeKey).sort((a, b) => (a ?? '').localeCompare(b ?? ''))
      ).toEqual(['deletion_protection.enabled', 'idle_timeout.timeout_seconds']);
      expect(declaredF.every((f) => f.path === 'LoadBalancerAttributes')).toBe(true);
    });

    it('R78: a stringly-equal Value (declared 60 number vs live "60") is NOT drift', () => {
      const findings = classifyResource(
        res(T, { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: 60 }] }),
        { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] },
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    });

    it('R78: TargetGroupAttributes is Key-scoped too', () => {
      const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
      const declaredF = classifyResource(
        res(TG, {
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }],
        }),
        {
          TargetGroupAttributes: [
            { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
            { Key: 'stickiness.enabled', Value: 'false' },
          ],
        },
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]).toMatchObject({
        path: 'TargetGroupAttributes',
        attributeKey: 'deregistration_delay.timeout_seconds',
        desired: '15',
        actual: '30',
      });
    });
  });

  describe('JSON-string vs declared object (SSM Document.Content)', () => {
    const T = 'AWS::SSM::Document';
    const content = {
      schemaVersion: '2.2',
      description: 'noop',
      mainSteps: [
        { action: 'aws:runShellScript', name: 'noop', inputs: { runCommand: ['echo hi'] } },
      ],
    };

    it('declared object vs the same value as a key-reordered JSON string is NOT drift', () => {
      // AWS returns the content as a string with keys in a different order
      const liveStr = JSON.stringify({
        description: 'noop',
        mainSteps: [
          { action: 'aws:runShellScript', inputs: { runCommand: ['echo hi'] }, name: 'noop' },
        ],
        schemaVersion: '2.2',
      });
      expect(
        classifyResource(res(T, { Content: content }), { Content: liveStr }, emptySchema)
      ).toEqual([]);
    });

    it('a genuine content change is still declared drift', () => {
      const liveStr = JSON.stringify({ ...content, description: 'CHANGED' });
      expect(
        tiers(classifyResource(res(T, { Content: content }), { Content: liveStr }, emptySchema))
          .declared
      ).toEqual(['Content']);
    });

    it('an unparseable live string is still drift (never silently equal)', () => {
      expect(
        tiers(
          classifyResource(res(T, { Content: content }), { Content: 'not json {' }, emptySchema)
        ).declared
      ).toEqual(['Content']);
    });
  });

  describe('case-insensitive scalar path (Route53 AliasTarget.DNSName)', () => {
    const T = 'AWS::Route53::RecordSet';
    const alias = (dns: string) => ({
      AliasTarget: { DNSName: dns, HostedZoneId: 'Z123', EvaluateTargetHealth: false },
    });

    it('mixed-case declared vs lowercase live DNS name is NOT drift', () => {
      expect(
        classifyResource(
          res(T, alias('dualstack.CdkrdI-Edge7-abc.us-east-1.elb.amazonaws.com')),
          alias('dualstack.cdkrdi-edge7-abc.us-east-1.elb.amazonaws.com'),
          emptySchema
        )
      ).toEqual([]);
    });

    it('a genuinely different DNS name is still drift', () => {
      expect(
        tiers(
          classifyResource(
            res(T, alias('dualstack.aaa.us-east-1.elb.amazonaws.com')),
            alias('dualstack.bbb.us-east-1.elb.amazonaws.com'),
            emptySchema
          )
        ).declared
      ).toEqual(['AliasTarget.DNSName']);
    });

    it('the case-insensitive rule is scoped per-type+path (other scalars still strict)', () => {
      // a different type with the same path shape stays strict
      expect(
        tiers(
          classifyResource(
            res('AWS::S3::Bucket', { Name: 'MyBucket' }),
            { Name: 'mybucket' },
            emptySchema
          )
        ).declared
      ).toEqual(['Name']);
    });
  });
});

describe('unordered-array declared false positives (R88, found by the wave-2 integ fixtures)', () => {
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
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared,
  });
  const declaredTiers = (
    rt: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    classifyResource(res(rt, declared), live, emptySchema)
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  describe('DynamoDB AttributeDefinitions / KeySchema (AttributeName identity, R88)', () => {
    const T = 'AWS::DynamoDB::Table';
    const declared = {
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'N' },
      ],
    };

    it('AWS returning the attributes in a different order is NOT drift', () => {
      const live = {
        AttributeDefinitions: [
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'N' },
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine attribute TYPE change still surfaces', () => {
      const live = {
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'N' }, // S -> N
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'N' },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('EC2 SecurityGroup ingress (identity-less object array, R88)', () => {
    const T = 'AWS::EC2::SecurityGroup';
    const declared = {
      SecurityGroupIngress: [
        { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: 'a' },
        { CidrIp: '10.0.1.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: 'b' },
        {
          CidrIp: '192.168.0.0/16',
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          Description: 'ssh',
        },
      ],
    };

    it('AWS returning the same rules in a different order is NOT drift', () => {
      const live = {
        SecurityGroupIngress: [
          {
            CidrIp: '192.168.0.0/16',
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            Description: 'ssh',
          },
          {
            CidrIp: '10.0.0.0/24',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            Description: 'a',
          },
          {
            CidrIp: '10.0.1.0/24',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            Description: 'b',
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine rule change (a port) still surfaces', () => {
      const live = {
        SecurityGroupIngress: [
          {
            CidrIp: '10.0.0.0/24',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            Description: 'a',
          },
          {
            CidrIp: '10.0.1.0/24',
            IpProtocol: 'tcp',
            FromPort: 8443,
            ToPort: 8443,
            Description: 'b',
          }, // 443 -> 8443
          {
            CidrIp: '192.168.0.0/16',
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            Description: 'ssh',
          },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });
});

describe('identity-keyed array ADDITIONS are detected, not subset-projected away (R95)', () => {
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
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared,
  });

  it('a tag ADDED out of band (live has a Key the template does not) is drift, NOT silently dropped', () => {
    const findings = classifyResource(
      res('AWS::S3::Bucket', { Tags: [{ Key: 'team', Value: 'platform' }] }),
      {
        Tags: [
          { Key: 'team', Value: 'platform' },
          { Key: 'rogue', Value: 'x' },
        ],
      },
      emptySchema
    );
    // before R95 this returned [] (the rogue tag was projected away) — the bug.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.tier === 'declared' && f.path.startsWith('Tags'))).toBe(true);
  });

  it('a CHANGED tag value is still detected (regression — changes were always caught)', () => {
    const findings = classifyResource(
      res('AWS::S3::Bucket', { Tags: [{ Key: 'team', Value: 'platform' }] }),
      { Tags: [{ Key: 'team', Value: 'CHANGED' }] },
      emptySchema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path.startsWith('Tags'))).toBe(true);
  });

  it('an ADDED Id-keyed element (e.g. a CloudFront Origin) is drift, not dropped', () => {
    const findings = classifyResource(
      res('AWS::CloudFront::Distribution', {
        DistributionConfig: { Origins: [{ Id: 'o1', DomainName: 'a.example' }] },
      }),
      {
        DistributionConfig: {
          Origins: [
            { Id: 'o1', DomainName: 'a.example' },
            { Id: 'o2', DomainName: 'b.example' },
          ],
        },
      },
      emptySchema
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('ELB attribute bags still compare as a SUBSET (declared 2, AWS returns extra defaults) — no false drift', () => {
    const T = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
    const declared = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ],
    };
    const liveAll = {
      LoadBalancerAttributes: [
        { Key: 'access_logs.s3.enabled', Value: 'false' },
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
        { Key: 'routing.http2.enabled', Value: 'true' },
      ],
    };
    expect(classifyResource(res(T, declared), liveAll, emptySchema)).toEqual([]);
  });
});

describe('nested undeclared detection (R96 — the differentiator at depth)', () => {
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
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared,
  });
  const f = (rt: string, d: Record<string, unknown>, l: Record<string, unknown>) =>
    classifyResource(res(rt, d), l, emptySchema);

  it('a live sub-key inside a DECLARED object the template never set is nested undeclared', () => {
    const out = f(
      'AWS::X::Y',
      { Conf: { Level: 'INFO' } },
      { Conf: { Level: 'INFO', Destination: 's3' } }
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'Conf.Destination', nested: true });
  });

  it('detects nested undeclared at ANY depth (A.B.D)', () => {
    const out = f('AWS::X::Y', { A: { B: { C: 1 } } }, { A: { B: { C: 1, D: 2 } } });
    expect(out.some((x) => x.tier === 'undeclared' && x.path === 'A.B.D' && x.nested)).toBe(true);
  });

  it('a CHANGE to a declared nested field is DECLARED drift, not nested-undeclared', () => {
    const out = f('AWS::X::Y', { Conf: { Level: 'INFO' } }, { Conf: { Level: 'CHANGED' } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'declared',
      path: 'Conf.Level',
      desired: 'INFO',
      actual: 'CHANGED',
    });
    expect(out[0]!.nested).toBeUndefined();
  });

  it('descends identity-keyed array elements (R98): a live sub-field in a declared element is nested undeclared', () => {
    const out = f('AWS::X::Y', { Items: [{ Id: 'a' }] }, { Items: [{ Id: 'a', Extra: 9 }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'Items[a].Extra', nested: true });
  });

  it('R98: matches array elements BY identity, not position (order differs after canonicalization)', () => {
    const out = f(
      'AWS::X::Y',
      { Items: [{ Id: 'a' }, { Id: 'b' }] },
      { Items: [{ Id: 'b' }, { Id: 'a', Extra: 9 }] }
    );
    expect(out.filter((x) => x.nested).map((x) => x.path)).toEqual(['Items[a].Extra']);
  });

  it('R98: a whole live-only ELEMENT is NOT emitted as nested (left to the declared compare)', () => {
    const out = f('AWS::X::Y', { Items: [{ Id: 'a' }] }, { Items: [{ Id: 'a' }, { Id: 'b' }] });
    expect(out.filter((x) => x.nested)).toEqual([]);
  });

  it('R98: identity-LESS object arrays are NOT descended (elements cannot be matched)', () => {
    // No Key/Id/AttributeName/IndexName on the elements → no reliable alignment.
    const out = f(
      'AWS::X::Y',
      { Rules: [{ Port: 80 }] },
      { Rules: [{ Port: 80, Description: 'added' }] }
    );
    expect(out.filter((x) => x.nested)).toEqual([]);
  });

  it('R98: a CHANGE to a declared field inside an array element is declared drift, not nested', () => {
    const out = f('AWS::X::Y', { Items: [{ Id: 'a', V: 1 }] }, { Items: [{ Id: 'a', V: 2 }] });
    expect(out.filter((x) => x.nested)).toEqual([]);
    expect(out.some((x) => x.tier === 'declared')).toBe(true);
  });

  it('nested trivially-empty / aws:* values are suppressed like top-level', () => {
    const out = f('AWS::X::Y', { Conf: { A: 1 } }, { Conf: { A: 1, EmptyList: [], EmptyObj: {} } });
    expect(out.filter((x) => x.nested)).toEqual([]);
  });

  it('no nested findings when the live object adds nothing beyond declared', () => {
    expect(f('AWS::X::Y', { Conf: { A: 1 } }, { Conf: { A: 1 } })).toEqual([]);
  });

  it('a nested READ-ONLY path (stripped from live) is NOT surfaced as nested undeclared', () => {
    // deepStripPaths(live, readOnlyPaths) runs BEFORE the nested recursion, so a
    // managed read-only sub-field never reaches collectNestedUndeclared. Pin that
    // interaction: without the strip this would be a false `Conf.Arn` nested finding.
    const schema: SchemaInfo = { ...emptySchema, readOnlyPaths: ['Conf.Arn'] };
    const out = classifyResource(
      res('AWS::X::Y', { Conf: { A: 1 } }),
      { Conf: { A: 1, Arn: 'arn:aws:x:::managed' } },
      schema
    );
    expect(out.filter((x) => x.nested)).toEqual([]);
  });

  it('a nested WRITE-ONLY path (stripped from both sides) is NOT surfaced as nested undeclared', () => {
    // writeOnly is stripped from BOTH declared and live (cannot be read back), so a
    // nested secret AWS never returns must not appear as drift on either side.
    const schema: SchemaInfo = { ...emptySchema, writeOnlyPaths: ['Conf.Secret'] };
    const out = classifyResource(
      res('AWS::X::Y', { Conf: { A: 1 } }),
      { Conf: { A: 1, Secret: 'shh' } },
      schema
    );
    expect(out.filter((x) => x.nested)).toEqual([]);
  });
});

describe('CloudFront OAI S3 BucketPolicy principal (real-AWS reproduced false positive)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const OAI_ID = 'EM4A89W3GHI3';
  const CANON =
    '9f136d368cf2e7a1231ec86b0e9fba1753e7182eda536b6294f93d5667ce29f71f5d58bb774dbb93d4a89e7b2c1a3c4e';
  const userArn = `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ${OAI_ID}`;
  // declared = CDK grantRead(oai): CanonicalUser carries the resolved S3CanonicalUserId
  const declared: DesiredResource = {
    logicalId: 'AssetsPolicy',
    resourceType: 'AWS::S3::BucketPolicy',
    physicalId: 'bucket',
    declared: {
      Bucket: 'bucket',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:GetObject', Principal: { CanonicalUser: CANON } },
        ],
      },
    },
  };
  // live = GetBucketPolicy: S3 returns the equivalent cloudfront:user ARN form
  const liveRaw = {
    Bucket: 'bucket',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Principal: { AWS: userArn } }],
    },
  };

  it('fires a false declared drift WITHOUT the resolved OAI map (documents the bug)', () => {
    const out = classifyResource(declared, liveRaw, bare);
    expect(out.some((f) => f.tier === 'declared')).toBe(true);
  });

  it('is CLEAN with the resolved OAI map (the fix)', () => {
    const out = classifyResource(declared, liveRaw, bare, {
      oaiCanonicalIds: { [OAI_ID]: CANON },
    });
    expect(out.filter((f) => f.tier === 'declared')).toEqual([]);
    expect(out.filter((f) => f.tier === 'undeclared')).toEqual([]);
  });

  it('still reports a repoint to a DIFFERENT OAI even with a map', () => {
    const otherLive = {
      Bucket: 'bucket',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: {
              AWS: 'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity OTHEROAI999',
            },
          },
        ],
      },
    };
    const out = classifyResource(declared, otherLive, bare, {
      oaiCanonicalIds: { [OAI_ID]: CANON },
    });
    expect(out.some((f) => f.tier === 'declared')).toBe(true);
  });
});

describe('nested atDefault folding (R103 — schema defaults at depth)', () => {
  const schema = (defaultPaths: Record<string, unknown>): SchemaInfo => ({
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths,
  });
  const res = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'R',
    resourceType: 'AWS::X::Y',
    physicalId: 'p',
    declared,
  });

  it('a nested live value EQUAL to its schema default folds as atDefault, not undeclared', () => {
    const out = classifyResource(
      res({ Conf: { A: 1 } }),
      { Conf: { A: 1, Timeout: 30 } },
      schema({ 'Conf.Timeout': 30 })
    );
    const f = out.find((x) => x.path === 'Conf.Timeout');
    expect(f?.tier).toBe('atDefault');
    expect(f?.nested).toBe(true);
  });

  it('a nested value CHANGED away from its schema default stays undeclared (surfaces)', () => {
    const out = classifyResource(
      res({ Conf: { A: 1 } }),
      { Conf: { A: 1, Timeout: 99 } },
      schema({ 'Conf.Timeout': 30 })
    );
    expect(out.find((x) => x.path === 'Conf.Timeout')?.tier).toBe('undeclared');
  });

  it('an array-element nested default folds: the live [<id>] path normalizes to the schema * key', () => {
    const out = classifyResource(
      res({ Origins: [{ Id: 'o1' }] }),
      { Origins: [{ Id: 'o1', Port: 80 }] },
      schema({ 'Origins.*.Port': 80 })
    );
    const f = out.find((x) => x.path === 'Origins[o1].Port');
    expect(f?.tier).toBe('atDefault');
  });

  it('a nested value with NO schema default stays undeclared', () => {
    const out = classifyResource(
      res({ Conf: { A: 1 } }),
      { Conf: { A: 1, Other: 5 } },
      schema({ 'Conf.Timeout': 30 })
    );
    expect(out.find((x) => x.path === 'Conf.Other')?.tier).toBe('undeclared');
  });
});

describe('nested KNOWN_DEFAULT_PATHS folding (R108 — hand-coded nested service defaults)', () => {
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
  const bare = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'L',
    resourceType,
    physicalId: 'phys',
    declared,
  });

  // Build {declared, live} from a dotted KNOWN_DEFAULT_PATHS key so the nested loop
  // fires: every intermediate object/array is DECLARED on both sides (an array
  // element carries an `Id` identity so the loop aligns it), and only the final
  // sub-key is live-only — exactly the shape the corpus exhibits. A `*` segment
  // becomes a one-element identity-keyed array.
  function buildNested(
    segments: string[],
    value: unknown
  ): [Record<string, unknown>, Record<string, unknown>] {
    const [head, ...rest] = segments;
    if (rest.length === 0) return [{}, { [head!]: value }];
    if (rest[0] === '*') {
      const [d, l] = buildNested(rest.slice(1), value);
      return [{ [head!]: [{ Id: 'x', ...d }] }, { [head!]: [{ Id: 'x', ...l }] }];
    }
    const [d, l] = buildNested(rest, value);
    return [{ [head!]: d }, { [head!]: l }];
  }
  const emittedPath = (schemaPath: string): string => schemaPath.replaceAll('.*.', '[x].');

  it('EVERY entry FOLDS its exact nested default to the atDefault tier (never drift, never dropped)', () => {
    for (const [resourceType, defs] of Object.entries(KNOWN_DEFAULT_PATHS)) {
      for (const [path, value] of Object.entries(defs)) {
        const [declared, live] = buildNested(path.split('.'), structuredClone(value));
        const findings = classifyResource(bare(resourceType, declared), live, emptySchema);
        const f = findings.find((x) => x.path === emittedPath(path));
        expect(f, `${resourceType} :: ${path}`).toBeDefined();
        expect(f, `${resourceType} :: ${path}`).toMatchObject({ tier: 'atDefault', nested: true });
      }
    }
  });

  it('a nested value CHANGED away from its known default surfaces as undeclared (equality-gated)', () => {
    const out = classifyResource(
      bare('AWS::ApiGateway::Method', { Integration: {} }),
      { Integration: { TimeoutInMillis: 5000 } },
      emptySchema
    );
    expect(out.find((x) => x.path === 'Integration.TimeoutInMillis')?.tier).toBe('undeclared');
  });

  it('the SAME nested key on an UNLISTED resource type is not folded', () => {
    const out = classifyResource(
      bare('AWS::Other::Thing', { Integration: {} }),
      { Integration: { TimeoutInMillis: 29000 } },
      emptySchema
    );
    expect(out.find((x) => x.path === 'Integration.TimeoutInMillis')?.tier).toBe('undeclared');
  });

  it('an array-element nested default folds via the live [<id>] -> * normalization', () => {
    const out = classifyResource(
      bare('AWS::CloudFront::Distribution', { DistributionConfig: { Origins: [{ Id: 'o1' }] } }),
      { DistributionConfig: { Origins: [{ Id: 'o1', ConnectionAttempts: 3 }] } },
      emptySchema
    );
    expect(
      out.find((x) => x.path === 'DistributionConfig.Origins[o1].ConnectionAttempts')?.tier
    ).toBe('atDefault');
  });
});

// GENERATED_DEFAULTS: an undeclared live value equal to the AWS/CDK auto-generated
// value for THIS resource (its minted physical name, or a default-named log group
// derived from the physical id) folds to the `generated` tier — never undeclared,
// never drift. Equality-gated against the physical-id-substituted template.
describe('GENERATED_DEFAULTS — physical-id-derived auto values fold to `generated`', () => {
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
  const res = (
    resourceType: string,
    physicalId: string | undefined,
    declared: Record<string, unknown> = {}
  ): DesiredResource => ({ logicalId: 'L', resourceType, physicalId, declared });

  it('SNS TopicName equal to the generated name segment of the ARN physical id folds', () => {
    const arn = 'arn:aws:sns:ap-northeast-1:111122223333:Stack-TopicABC123-9F16VRgpExOs';
    const out = classifyResource(
      res('AWS::SNS::Topic', arn),
      { TopicName: 'Stack-TopicABC123-9F16VRgpExOs' },
      emptySchema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'generated', path: 'TopicName' });
  });

  it('Lambda default LoggingConfig whose LogGroup is named after the function physical id folds', () => {
    const fn = 'Stack-HandlerABC123-d8tC4w62HoBi';
    const out = classifyResource(
      res('AWS::Lambda::Function', fn),
      { LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${fn}` } },
      emptySchema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'generated', path: 'LoggingConfig' });
  });

  it('an out-of-band edit inside the generated value (LogFormat → JSON) no longer matches → undeclared', () => {
    const fn = 'Stack-HandlerABC123-d8tC4w62HoBi';
    const out = classifyResource(
      res('AWS::Lambda::Function', fn),
      { LoggingConfig: { LogFormat: 'JSON', LogGroup: `/aws/lambda/${fn}` } },
      emptySchema
    );
    expect(tiers(out).undeclared).toEqual(['LoggingConfig']);
    expect(tiers(out).generated).toEqual([]);
  });

  it('a TopicName NOT matching the physical id stays undeclared (a real out-of-band name)', () => {
    const out = classifyResource(
      res('AWS::SNS::Topic', 'arn:aws:sns:us-east-1:111122223333:Stack-TopicABC123-xyz'),
      { TopicName: 'totally-different-name' },
      emptySchema
    );
    expect(tiers(out).undeclared).toEqual(['TopicName']);
  });

  it('with no physical id the template cannot resolve, so the value stays undeclared', () => {
    const out = classifyResource(
      res('AWS::SNS::Topic', undefined),
      { TopicName: 'Stack-TopicABC123-9F16VRgpExOs' },
      emptySchema
    );
    expect(tiers(out).undeclared).toEqual(['TopicName']);
    expect(tiers(out).generated).toEqual([]);
  });

  it('a declared property is never reclassified as generated (declared side wins)', () => {
    const arn = 'arn:aws:sns:us-east-1:111122223333:Stack-TopicABC123-9F16VRgpExOs';
    const out = classifyResource(
      res('AWS::SNS::Topic', arn, { TopicName: 'Stack-TopicABC123-9F16VRgpExOs' }),
      { TopicName: 'Stack-TopicABC123-9F16VRgpExOs' },
      emptySchema
    );
    // declared + equal live → no finding at all (not generated, not drift)
    expect(out).toEqual([]);
  });

  // R107: the general name rule (isGeneratedName) folds a scalar generated name for
  // ANY type, with no per-type GENERATED_DEFAULTS entry.
  it('StepFunctions StateMachineName (no table entry) folds via the ARN name segment', () => {
    const arn = 'arn:aws:states:us-east-1:111122223333:stateMachine:Stack-SMabc123-Xy7Z';
    const out = classifyResource(
      res('AWS::StepFunctions::StateMachine', arn),
      { StateMachineName: 'Stack-SMabc123-Xy7Z' },
      emptySchema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'generated', path: 'StateMachineName' });
  });

  it('a name whose value EQUALS the bare physical id (no ARN) stays the structural drop, not generated', () => {
    // value === physicalId is the long-standing structural-noise drop (kept narrow):
    // R107 only adds the ARN name-SEGMENT case, so this bare-id echo is dropped, not folded
    const out = classifyResource(
      res('AWS::IAM::Role', 'Stack-RoleABC123-K9pQ'),
      { RoleName: 'Stack-RoleABC123-K9pQ' },
      emptySchema
    );
    expect(out).toEqual([]); // dropped, neither generated nor undeclared
  });

  it('a non-name scalar that does NOT equal the physical name stays undeclared', () => {
    const out = classifyResource(
      res(
        'AWS::StepFunctions::StateMachine',
        'arn:aws:states:us-east-1:111122223333:stateMachine:Stack-SMabc123-Xy7Z'
      ),
      { LoggingConfiguration: { Level: 'ALL' } },
      emptySchema
    );
    expect(tiers(out).undeclared).toEqual(['LoggingConfiguration']);
    expect(tiers(out).generated).toEqual([]);
  });

  it('the exact full-id echo stays the structural drop (R107 only adds the name segment)', () => {
    // value === the whole physical id (the resource ARN) is the structural drop, NOT
    // the new ARN name-segment rule — keeps R107 narrow and corpus-stable
    const out = classifyResource(
      res('AWS::SNS::Topic', 'arn:aws:sns:us-east-1:111122223333:Stack-Topic-abc'),
      { SomeArnProp: 'arn:aws:sns:us-east-1:111122223333:Stack-Topic-abc' },
      emptySchema
    );
    expect(out).toEqual([]); // dropped, not generated
  });
});

// R130: RDS DBInstance fresh-deploy false positives observed in harvest13 — a declared
// EngineVersion track resolved to its full patch, and a MasterUsername declared as a
// secretsmanager dynamic reference resolved to the live username. Neither is drift.
describe('classifyResource RDS version-track + dynamic-reference (R130)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const declaredPaths = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  it('EngineVersion "8.0" resolved to live "8.0.45" is NOT declared drift', () => {
    expect(
      declaredPaths('AWS::RDS::DBInstance', { EngineVersion: '8.0' }, { EngineVersion: '8.0.45' })
    ).toEqual([]);
  });

  it('a genuine EngineVersion track change IS declared drift', () => {
    expect(
      declaredPaths('AWS::RDS::DBInstance', { EngineVersion: '8.1' }, { EngineVersion: '8.0.45' })
    ).toEqual(['EngineVersion']);
  });

  it('the version-prefix rule is gated to RDS — same shape on another type is drift', () => {
    expect(declaredPaths('AWS::Other::Thing', { Version: '8.0' }, { Version: '8.0.45' })).toEqual([
      'Version',
    ]);
  });

  it('MasterUsername resolved to UNRESOLVED (dynamic ref) is unresolved, not declared drift', () => {
    // loadDesired resolves the {{resolve:secretsmanager:…}} dynamic reference to
    // UNRESOLVED; classify then emits an `unresolved` finding, never `declared`.
    const out = classifyResource(
      {
        logicalId: 'R',
        resourceType: 'AWS::RDS::DBInstance',
        physicalId: 'p',
        declared: { MasterUsername: UNRESOLVED },
      },
      { MasterUsername: 'admin' },
      bare
    );
    expect(out.filter((f) => f.tier === 'declared')).toEqual([]);
    expect(out.filter((f) => f.tier === 'unresolved').map((f) => f.path)).toEqual([
      'MasterUsername',
    ]);
  });
});

describe('partial-unresolved declared compare (WAVE20 F1 — a sibling drift is not hidden)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const run = (declared: Record<string, unknown>, live: Record<string, unknown>) =>
    classifyResource(
      { logicalId: 'R', resourceType: 'AWS::Foo::Bar', physicalId: 'p', declared },
      live,
      bare
    );

  it('a RESOLVED sibling sub-value drift surfaces even when another sub-value is unresolved', () => {
    // Environment.Variables: TABLE_ARN is a GetAtt (UNRESOLVED), LOG_LEVEL is a literal
    // that drifted out of band. Before the fix the WHOLE property was skipped as
    // unresolved, hiding the LOG_LEVEL change.
    const out = run(
      { Env: { TABLE_ARN: UNRESOLVED, LOG_LEVEL: 'INFO' } },
      { Env: { TABLE_ARN: 'arn:aws:dynamodb:::table/x', LOG_LEVEL: 'DEBUG' } }
    );
    // the property is still flagged unresolved (the GetAtt part is unverifiable)...
    expect(out.filter((f) => f.tier === 'unresolved').map((f) => f.path)).toEqual(['Env']);
    // ...AND the resolved sibling's drift is now a declared finding
    expect(out.filter((f) => f.tier === 'declared')).toEqual([
      {
        tier: 'declared',
        logicalId: 'R',
        resourceType: 'AWS::Foo::Bar',
        path: 'Env.LOG_LEVEL',
        desired: 'INFO',
        actual: 'DEBUG',
        physicalId: 'p',
      },
    ]);
  });

  it('FP-safe: when the resolved siblings all match, only the unresolved note is emitted', () => {
    const out = run(
      { Env: { TABLE_ARN: UNRESOLVED, LOG_LEVEL: 'INFO' } },
      { Env: { TABLE_ARN: 'arn:aws:dynamodb:::table/x', LOG_LEVEL: 'INFO' } }
    );
    expect(out.filter((f) => f.tier === 'declared')).toEqual([]);
    expect(out.filter((f) => f.tier === 'unresolved').map((f) => f.path)).toEqual(['Env']);
  });

  it('the unresolved leaf itself is never reported as declared drift (vs the symbol)', () => {
    const out = run({ Env: { A: UNRESOLVED } }, { Env: { A: 'anything' } });
    expect(out.filter((f) => f.tier === 'declared')).toEqual([]);
    expect(out.filter((f) => f.tier === 'unresolved').map((f) => f.path)).toEqual(['Env']);
  });

  it('a partially-unresolved property absent from live is a single unresolved note (no compare)', () => {
    const out = run({ Env: { A: UNRESOLVED, B: 'x' } }, {});
    expect(out.filter((f) => f.tier === 'unresolved').map((f) => f.path)).toEqual(['Env']);
    expect(out.filter((f) => f.tier === 'declared')).toEqual([]);
    expect(out.filter((f) => f.tier === 'readGap')).toEqual([]);
  });
});

// An IAM policy Condition value is an UNORDERED SET of strings written as a scalar
// or an array. AWS may echo a multi-value condition (a CDK enforceSSL /
// grant-with-SourceArn statement) reordered, or store a scalar-declared value as a
// one-element array — both were false `declared` drift before canonicalizeCondition.
describe('classifyResource IAM policy Condition canonicalization', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const declaredPaths = (declared: Record<string, unknown>, live: Record<string, unknown>) =>
    classifyResource(
      { logicalId: 'R', resourceType: 'AWS::SNS::TopicPolicy', physicalId: 'p', declared },
      live,
      bare
    )
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);
  const stmt = (cond: unknown) => ({
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sns:Publish', Resource: '*', Condition: cond }],
    },
  });

  it('a reordered multi-value Condition is NOT declared drift', () => {
    expect(
      declaredPaths(
        stmt({ StringEquals: { 'aws:SourceArn': ['arnA', 'arnB'] } }),
        stmt({ StringEquals: { 'aws:SourceArn': ['arnB', 'arnA'] } })
      )
    ).toEqual([]);
  });

  it('a scalar-declared Condition value AWS stores as a one-element array is NOT drift', () => {
    expect(
      declaredPaths(
        stmt({ StringEquals: { 'aws:SourceAccount': '123456789012' } }),
        stmt({ StringEquals: { 'aws:SourceAccount': ['123456789012'] } })
      )
    ).toEqual([]);
  });

  it('a GENUINE Condition value change IS still declared drift', () => {
    expect(
      declaredPaths(
        stmt({ StringEquals: { 'aws:SourceArn': ['arnA', 'arnB'] } }),
        stmt({ StringEquals: { 'aws:SourceArn': ['arnA', 'arnC'] } })
      )
    ).not.toEqual([]);
  });
});

describe('normalizeLiveModel (PR4 — the shared live-model normalizer used for `added`)', () => {
  const schema: SchemaInfo = {
    readOnly: new Set(['MethodId']),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: ['MethodId'],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };

  it('strips readOnly paths so a volatile id never reads as a change', () => {
    const out = normalizeLiveModel({ AuthorizationType: 'NONE', MethodId: 'volatile-123' }, schema);
    expect(out).toEqual({ AuthorizationType: 'NONE' });
    expect(out.MethodId).toBeUndefined();
  });

  it('canonicalizes tag lists (unordered) so element order is not a false change', () => {
    const a = normalizeLiveModel(
      {
        Tags: [
          { Key: 'b', Value: '2' },
          { Key: 'a', Value: '1' },
        ],
      },
      schema
    );
    const b = normalizeLiveModel(
      {
        Tags: [
          { Key: 'a', Value: '1' },
          { Key: 'b', Value: '2' },
        ],
      },
      schema
    );
    expect(a).toEqual(b);
  });

  it('does not mutate the input model', () => {
    const input = { AuthorizationType: 'NONE', MethodId: 'x' };
    normalizeLiveModel(input, schema);
    expect(input).toEqual({ AuthorizationType: 'NONE', MethodId: 'x' });
  });
});

// A live-only sub-key ADDED to a declared IAM policy STATEMENT out of band (e.g. a
// Condition) was invisible: statements are identity-less, so the nested-undeclared
// descent skipped them. Now an Effect-marked statement array is descended via a
// subset match — catching the sub-key while leaving other identity-less arrays
// (SecurityGroup rules) untouched.
describe('nested undeclared on IAM policy statements (identity-less subset descent)', () => {
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
  const policyRes = (statements: unknown[]): DesiredResource => ({
    logicalId: 'P',
    resourceType: 'AWS::IAM::ManagedPolicy',
    physicalId: 'p',
    declared: { PolicyDocument: { Version: '2012-10-17', Statement: statements } },
  });

  it('detects a Condition added out of band to a declared statement (the FN this fixes)', () => {
    const res = policyRes([{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:b' }]);
    const live = {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Resource: 'arn:b',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } }, // added out of band
          },
        ],
      },
    };
    const t = tiers(classifyResource(res, live, emptySchema));
    expect(t.undeclared).toContain('PolicyDocument.Statement[0].Condition');
  });

  it('CLEAN when the live policy equals the declared policy (no false nested undeclared)', () => {
    const stmt = { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:b' };
    const t = tiers(
      classifyResource(
        policyRes([stmt]),
        { PolicyDocument: { Version: '2012-10-17', Statement: [{ ...stmt }] } },
        emptySchema
      )
    );
    expect(t.undeclared).toEqual([]);
    expect(t.declared).toEqual([]);
  });

  it('subset-match survives the statement re-sort: detects the added key on the right statement', () => {
    const res = policyRes([
      { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:a' },
      { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:b' },
    ]);
    // the put-object statement gains a Condition live; canonicalization re-sorts
    // statements by content, so positional alignment would misfire — subset match must
    // still pin the Condition to the put-object statement and leave the other clean.
    const live = {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:PutObject',
            Resource: 'arn:b',
            Condition: { StringEquals: { 'aws:username': 'x' } },
          },
          { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:a' },
        ],
      },
    };
    const t = tiers(classifyResource(res, live, emptySchema));
    expect(t.undeclared.filter((p) => p.endsWith('.Condition'))).toHaveLength(1);
    expect(t.undeclared.some((p) => p.endsWith('.Condition'))).toBe(true);
    expect(t.declared).toEqual([]); // no false declared drift on the reordered clean statement
  });

  it('FP-safe: an identity-less array WITHOUT an Effect marker (SecurityGroup-rule shape) is NOT descended', () => {
    const res: DesiredResource = {
      logicalId: 'SG',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg',
      declared: {
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
        ],
      },
    };
    const live = {
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
          Description: 'added',
        },
      ],
    };
    const t = tiers(classifyResource(res, live, emptySchema));
    expect(t.undeclared.some((p) => p.includes('Description'))).toBe(false);
  });
});

describe('REFLECTED_CHILD_PROPS (drop a parent reflection of its child resources)', () => {
  const schema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const topic = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'Topic',
    resourceType: 'AWS::SNS::Topic',
    physicalId: 'arn:aws:sns:us-east-1:111122223333:t',
    declared,
  });

  it('SNS Topic.Subscription reflection is NOT flagged undeclared (tracked as resources)', () => {
    const live = {
      DisplayName: 'd',
      Subscription: [{ Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:111122223333:q' }],
    };
    const findings = classifyResource(topic({ DisplayName: 'd' }), live, schema);
    expect(findings.find((f) => f.path === 'Subscription')).toBeUndefined();
  });

  it('but a Topic that DECLARES inline Subscription still compares it (fail-open)', () => {
    const declaredSubs = [{ Protocol: 'sqs', Endpoint: 'arn:declared' }];
    const liveSubs = [{ Protocol: 'sqs', Endpoint: 'arn:CHANGED' }];
    const findings = classifyResource(
      topic({ Subscription: declaredSubs }),
      { Subscription: liveSubs },
      schema
    );
    // the reflection is NOT dropped (declared), so the change surfaces as declared drift
    // on a Subscription-rooted path (exact path shape depends on the array diff).
    expect(findings.some((f) => f.tier === 'declared' && f.path.startsWith('Subscription'))).toBe(
      true
    );
  });
});

describe('R140: nested AWS-populated values fold (so a clean deploy is clean)', () => {
  const schema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const res = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'R',
    resourceType,
    physicalId: 'phys',
    declared,
  });

  it('ApiGateway DomainName EndpointConfiguration.IpAddressType ipv4 folds as atDefault', () => {
    const findings = classifyResource(
      res('AWS::ApiGateway::DomainName', { EndpointConfiguration: { Types: ['REGIONAL'] } }),
      { EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'ipv4' } },
      schema
    );
    const f = findings.find((x) => x.path === 'EndpointConfiguration.IpAddressType')!;
    expect(f.tier).toBe('atDefault');
    expect(f.nested).toBe(true);
  });

  it('a CHANGED IpAddressType surfaces as undeclared (equality-gated)', () => {
    const findings = classifyResource(
      res('AWS::ApiGateway::DomainName', { EndpointConfiguration: { Types: ['REGIONAL'] } }),
      { EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'dualstack' } },
      schema
    );
    const f = findings.find((x) => x.path === 'EndpointConfiguration.IpAddressType')!;
    expect(f.tier).toBe('undeclared');
  });

  // CacheNamespace defaults to the PARENT Resource id = the MIDDLE segment of the Method's
  // own physical id (`RestApiId|ResourceId|HttpMethod`). R142: fold as `generated` ONLY when
  // the value echoes a physical-id segment, so a CUSTOM value the user set still surfaces.
  const method: DesiredResource = {
    logicalId: 'M',
    resourceType: 'AWS::ApiGateway::Method',
    physicalId: 'api1|res9|GET',
    declared: { Integration: { Type: 'MOCK' } },
  };
  const cacheNsFinding = (cacheNs: string) =>
    classifyResource(
      method,
      { Integration: { Type: 'MOCK', CacheNamespace: cacheNs } },
      schema
    ).find((x) => x.path === 'Integration.CacheNamespace')!;

  it('CacheNamespace == the parent Resource id (a physical-id segment) folds as generated', () => {
    const f = cacheNsFinding('res9'); // the middle segment of api1|res9|GET
    expect(f.tier).toBe('generated');
    expect(f.nested).toBe(true);
  });

  it('a CUSTOM CacheNamespace (not a physical-id segment) surfaces as undeclared', () => {
    expect(cacheNsFinding('my-custom-ns').tier).toBe('undeclared');
  });
});

describe('Cognito UserPool Schema identity-keyed subset (WAVE23 — declared attrs vs the full live set)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const pool = (declared: Record<string, unknown>) => ({
    logicalId: 'Pool',
    resourceType: 'AWS::Cognito::UserPool',
    physicalId: 'p',
    declared,
  });
  const liveAttr = (Name: string, over: Record<string, unknown> = {}) => ({
    Name,
    AttributeDataType: 'String',
    DeveloperOnlyAttribute: false,
    Mutable: true,
    Required: false,
    StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
    ...over,
  });
  // AWS always returns the full standard-attribute set plus declared customs
  const liveStandard = ['sub', 'phone_number', 'address', 'birthdate', 'name'].map((n) =>
    liveAttr(n)
  );

  it('a declared attribute subset does NOT false-drift against the full live Schema', () => {
    // CDK emits a custom attribute as the BARE name `tier`; Cognito returns it prefixed
    // as `custom:tier`. The identity match normalizes the prefix so the declared subset
    // aligns to live and does not false-drift.
    const declared = {
      Schema: [
        { Name: 'email', Mutable: true, Required: true },
        { Name: 'tier', AttributeDataType: 'String', Mutable: true },
      ],
    };
    const live = {
      Schema: [...liveStandard, liveAttr('email', { Required: true }), liveAttr('custom:tier')],
    };
    const findings = classifyResource(pool(declared), live, bare);
    // no whole-array declared FALSE positive (the prefix mismatch is normalized away)
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // the always-present standard attributes each surface as a foldable nested undeclared
    // inventory element (server-enriched sub-keys of the matched declared attrs may add
    // more nested undeclared findings — all foldable, none a declared drift)
    const undeclaredPaths = findings
      .filter((f) => f.tier === 'undeclared' && f.nested)
      .map((f) => f.path);
    for (const n of ['sub', 'phone_number', 'address', 'birthdate', 'name']) {
      expect(undeclaredPaths).toContain(`Schema[${n}]`);
    }
  });

  it('an out-of-band change to a DECLARED attribute is reported as declared drift', () => {
    const declared = { Schema: [{ Name: 'email', Mutable: true, Required: true }] };
    const live = { Schema: [...liveStandard, liveAttr('email', { Required: false })] };
    const declaredDrift = classifyResource(pool(declared), live, bare).filter(
      (f) => f.tier === 'declared'
    );
    expect(declaredDrift).toHaveLength(1);
    expect(declaredDrift[0]).toMatchObject({ desired: true, actual: false });
  });

  it('a declared attribute absent from live (removed from the pool) is declared drift', () => {
    const declared = { Schema: [{ Name: 'custom:gone', AttributeDataType: 'String' }] };
    const live = { Schema: [...liveStandard] }; // custom:gone not present
    const declaredDrift = classifyResource(pool(declared), live, bare).filter(
      (f) => f.tier === 'declared'
    );
    expect(declaredDrift).toHaveLength(1);
  });

  it('an out-of-band CUSTOM attribute added (never declared) surfaces as undeclared', () => {
    const declared = { Schema: [{ Name: 'email', Mutable: true }] };
    const live = { Schema: [...liveStandard, liveAttr('email'), liveAttr('custom:rogue')] };
    // the path carries the normalized identity (the `custom:` prefix is stripped)
    const undeclared = classifyResource(pool(declared), live, bare).filter(
      (f) => f.tier === 'undeclared' && f.path === 'Schema[rogue]'
    );
    expect(undeclared).toHaveLength(1);
  });
});

describe('Name-keyed object arrays are identity-aligned (WAVE24 — ECS env vars, Alarm dimensions)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const task = (env: { Name: string; Value: string }[]) => ({
    logicalId: 'Task',
    resourceType: 'AWS::ECS::TaskDefinition',
    physicalId: 'p',
    declared: { ContainerDefinitions: [{ Name: 'app', Environment: env }] },
  });

  it('a reordered ECS Environment array is NOT false declared drift (Cloud Control shuffles it)', () => {
    const declared = task([
      { Name: 'ZEBRA', Value: '1' },
      { Name: 'ALPHA', Value: '2' },
      { Name: 'MIKE', Value: '3' },
    ]);
    // AWS returns the same set in a different order
    const live = {
      ContainerDefinitions: [
        {
          Name: 'app',
          Environment: [
            { Name: 'MIKE', Value: '3' },
            { Name: 'ZEBRA', Value: '1' },
            { Name: 'ALPHA', Value: '2' },
          ],
        },
      ],
    };
    expect(classifyResource(declared, live, bare).filter((f) => f.tier === 'declared')).toEqual([]);
  });

  it('a genuine ECS Environment value change still surfaces as declared drift', () => {
    const declared = task([
      { Name: 'ZEBRA', Value: '1' },
      { Name: 'ALPHA', Value: '2' },
    ]);
    const live = {
      ContainerDefinitions: [
        {
          Name: 'app',
          Environment: [
            { Name: 'ALPHA', Value: 'CHANGED' },
            { Name: 'ZEBRA', Value: '1' },
          ],
        },
      ],
    };
    const declaredDrift = classifyResource(declared, live, bare).filter(
      (f) => f.tier === 'declared'
    );
    expect(declaredDrift).toHaveLength(1);
    expect(declaredDrift[0]).toMatchObject({ actual: 'CHANGED' });
  });
});

describe('unordered-set props are order-stable in the live model (WAVE24 — baseline match)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const rule = (port: number) => ({
    CidrIp: '0.0.0.0/0',
    IpProtocol: 'tcp',
    FromPort: port,
    ToPort: port,
  });
  const sg = {
    logicalId: 'SG',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-1',
    declared: {},
  };

  it('an UNDECLARED SecurityGroupIngress set is emitted in a STABLE order across reordered reads', () => {
    const a = classifyResource(
      sg,
      { SecurityGroupIngress: [rule(22), rule(80), rule(443)] },
      bare
    ).find((f) => f.path === 'SecurityGroupIngress');
    const b = classifyResource(
      sg,
      { SecurityGroupIngress: [rule(443), rule(22), rule(80)] },
      bare
    ).find((f) => f.path === 'SecurityGroupIngress');
    // identical recorded value -> baselineValueMatches stays true (no false "changed since record")
    expect(a?.actual).toEqual(b?.actual);
  });

  it('an UNDECLARED Cognito OAuth scalar set is order-stable too', () => {
    const c = {
      logicalId: 'C',
      resourceType: 'AWS::Cognito::UserPoolClient',
      physicalId: 'c',
      declared: {},
    };
    const a = classifyResource(
      c,
      { AllowedOAuthScopes: ['openid', 'email', 'profile'] },
      bare
    ).find((f) => f.path === 'AllowedOAuthScopes');
    const b = classifyResource(
      c,
      { AllowedOAuthScopes: ['profile', 'openid', 'email'] },
      bare
    ).find((f) => f.path === 'AllowedOAuthScopes');
    expect(a?.actual).toEqual(b?.actual);
  });

  it('a genuine SecurityGroupIngress change still differs (not masked by the sort)', () => {
    const a = classifyResource(sg, { SecurityGroupIngress: [rule(22), rule(80)] }, bare).find(
      (f) => f.path === 'SecurityGroupIngress'
    );
    const b = classifyResource(sg, { SecurityGroupIngress: [rule(22), rule(8080)] }, bare).find(
      (f) => f.path === 'SecurityGroupIngress'
    );
    expect(a?.actual).not.toEqual(b?.actual);
  });
});

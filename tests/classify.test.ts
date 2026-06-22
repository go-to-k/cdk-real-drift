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

  // Reported bug: a Glue Table's `TableInput.Parameters` is a free-form
  // Map<String,String> whose keys hold a `.` (`projection.enabled`), so the
  // drift-calculator emits the WHOLE map as one record. CDK declares some values
  // typed (boolean `projection.enabled: true`) while AWS stores every value as a
  // string ("true") — the strict deepEqual then false-drifts the whole map. The
  // typed<->string coercion must fold across the whole map; a real key add/remove
  // or value change still surfaces.
  it('whole free-form map typed<->string coercion is not declared drift, real change still is', () => {
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
      logicalId: 'LogsTable',
      resourceType: 'AWS::Glue::Table',
      physicalId: 'logs-table',
      declared: {
        TableInput: {
          Parameters: {
            'projection.enabled': true, // CDK emits a typed boolean
            'skip.header.line.count': 2, // CDK emits a typed number
            'projection.date.type': 'date',
            'projection.date.range': '2024/04/01/00, NOW',
          },
        },
      },
    };
    // AWS returns every Map<String,String> value as a string, keys reordered.
    const clean = tiers(
      classifyResource(
        res,
        {
          TableInput: {
            Parameters: {
              'projection.date.type': 'date',
              'projection.date.range': '2024/04/01/00, NOW',
              'skip.header.line.count': '2',
              'projection.enabled': 'true',
            },
          },
        },
        emptySchema
      )
    );
    expect(clean.declared).toEqual([]);
    // A genuine value change in one map entry still surfaces as declared drift.
    const drifted = tiers(
      classifyResource(
        res,
        {
          TableInput: {
            Parameters: {
              'projection.date.type': 'date',
              'projection.date.range': 'CHANGED, NOW',
              'skip.header.line.count': '2',
              'projection.enabled': 'true',
            },
          },
        },
        emptySchema
      )
    );
    // the whole free-form map is one record, so the drift path is the map property
    expect(drifted.declared).toEqual(['TableInput.Parameters']);
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

  it("declared role Policies + UNRESOLVED sibling: the Policies finding carries the 'unresolved' marker (revert hazard)", () => {
    // With an unresolved sibling the live Policies array is NOT filtered, so the
    // declared compare (own vs own+sibling) emits a declared Policies finding. It must
    // carry siblingPolicyNames:'unresolved' so the revert plan refuses — a per-entry
    // revert would otherwise DELETE the sibling-managed DefaultPolicy entry.
    const declared = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] };
    const live = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }, sibling] };
    const findings = classifyResource(role('unresolved', declared), live, noSchema);
    const f = findings.find((x) => x.path === 'Policies');
    expect(f).toBeDefined();
    expect(f!.siblingPolicyNames).toBe('unresolved');
  });

  it('a resolved sibling never stamps the marker (revert stays enabled for the rogue case)', () => {
    const declared = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] };
    const live = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }, rogue] };
    const findings = classifyResource(role(['RoleDefaultPolicyABC'], declared), live, noSchema);
    for (const f of findings) expect(f.siblingPolicyNames).toBeUndefined();
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

  it('noise-sweep batch: the default folds, a flipped (security-relevant) value surfaces', () => {
    const t = (rt: string, live: Record<string, unknown>) =>
      tiers(classifyResource(bare(rt), live, emptySchema));
    // Cognito DeletionProtection: default INACTIVE folds; turning it ON is meaningful → surfaces
    expect(t('AWS::Cognito::UserPool', { DeletionProtection: 'INACTIVE' }).atDefault).toEqual([
      'DeletionProtection',
    ]);
    expect(t('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' }).undeclared).toEqual([
      'DeletionProtection',
    ]);
    // KMS Key Enabled: default true folds. (Enabled:false is dropped upstream as
    // trivially-empty, pre-existing — not this batch's concern.)
    expect(t('AWS::KMS::Key', { Enabled: true }).atDefault).toEqual(['Enabled']);
    // ECR mutability: default MUTABLE folds; IMMUTABLE surfaces
    expect(t('AWS::ECR::Repository', { ImageTagMutability: 'IMMUTABLE' }).undeclared).toEqual([
      'ImageTagMutability',
    ]);
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
            client({ ReadAttributes: ['email', 'name'] }),
            { ReadAttributes: ['name', 'email'] },
            emptySchema
          )
        ).declared
      ).toEqual(['ReadAttributes']);
    });

    // Live-observed FP (cognito-callbackurls fixture): Cognito reorders the
    // CallbackURLs / LogoutURLs sets — declared [zeta,alpha,mike] read back
    // [alpha,mike,zeta]. Same set-reorder class as the OAuth lists, now folded.
    it('UNORDERED_ARRAY_PROPS: Cognito CallbackURLs/LogoutURLs reorder is NOT drift', () => {
      const client = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'WebClient',
        resourceType: 'AWS::Cognito::UserPoolClient',
        physicalId: 'client123',
        declared,
      });
      for (const prop of ['CallbackURLs', 'LogoutURLs']) {
        // reordered same set -> no drift
        expect(
          classifyResource(
            client({ [prop]: ['https://z.example', 'https://a.example', 'https://m.example'] }),
            { [prop]: ['https://a.example', 'https://m.example', 'https://z.example'] },
            emptySchema
          )
        ).toEqual([]);
        // a genuine URL add/remove still changes the multiset -> reports
        expect(
          tiers(
            classifyResource(
              client({ [prop]: ['https://z.example', 'https://a.example'] }),
              { [prop]: ['https://a.example', 'https://NEW.example'] },
              emptySchema
            )
          ).declared
        ).toEqual([prop]);
      }
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

    // Live-observed FP (route53-multivalue fixture): a multi-value DNS RecordSet's
    // ResourceRecords are a SET — Route53 echoes them in its own canonical order
    // (declared TXT [zeta,alpha,mike] read back [mike,alpha,zeta]; A IPs reordered).
    it('UNORDERED_ARRAY_PROPS: Route53 RecordSet ResourceRecords reorder is NOT drift', () => {
      const rec = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'TxtRecord',
        resourceType: 'AWS::Route53::RecordSet',
        physicalId: 'rec-1',
        declared,
      });
      // same value set, reordered — no drift
      expect(
        classifyResource(
          rec({ ResourceRecords: ['"zeta"', '"alpha"', '"mike"'] }),
          { ResourceRecords: ['"mike"', '"alpha"', '"zeta"'] },
          emptySchema
        )
      ).toEqual([]);
      // a genuine value change still reports
      expect(
        tiers(
          classifyResource(
            rec({ ResourceRecords: ['203.0.113.30', '203.0.113.10'] }),
            { ResourceRecords: ['203.0.113.99', '203.0.113.10'] },
            emptySchema
          )
        ).declared
      ).toEqual(['ResourceRecords']);
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

    it('a fresh deploy with extra live attributes is NOT declared drift (subset compared)', () => {
      const findings = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: liveAll },
        emptySchema
      );
      // the 2 declared keys match -> zero DECLARED drift (no false positive)
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    });

    it('fail-closed: live-only (undeclared) bag keys ARE emitted as undeclared inventory', () => {
      // Before the fix the undeclared bag keys reached NO dimension (not even record),
      // so an out-of-band change to an UNDECLARED attribute (routing.http2.enabled,
      // access_logs.s3.enabled) was a permanent silent FN. Now each live-only key is
      // emitted as nested undeclared inventory -> record snapshots it, a later change
      // surfaces vs the baseline. (This test fails without the fix: findings would be [].)
      const undeclared = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: liveAll },
        emptySchema
      ).filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path).sort()).toEqual([
        'LoadBalancerAttributes[access_logs.s3.enabled]',
        'LoadBalancerAttributes[client_keep_alive.seconds]',
        'LoadBalancerAttributes[routing.http2.enabled]',
      ]);
      // the undeclared finding carries the live value + is nested-flagged (foldable/recordable)
      const http2 = undeclared.find(
        (f) => f.path === 'LoadBalancerAttributes[routing.http2.enabled]'
      );
      expect(http2).toMatchObject({ actual: 'true', nested: true });
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

  // Found live by the batch-rich bug-hunt fixture: CDK's FargateComputeEnvironment
  // emits `Type: "managed"` (lowercase) but the Batch live read canonicalizes it to
  // `"MANAGED"` (uppercase), a case-only difference on a create-only enum.
  describe('case-insensitive scalar path (Batch ComputeEnvironment Type)', () => {
    const T = 'AWS::Batch::ComputeEnvironment';

    it('lowercase declared `managed` vs uppercase live `MANAGED` is NOT drift', () => {
      expect(
        classifyResource(res(T, { Type: 'managed' }), { Type: 'MANAGED' }, emptySchema)
      ).toEqual([]);
    });

    it('a genuinely different Type (managed vs unmanaged) is still drift', () => {
      expect(
        tiers(classifyResource(res(T, { Type: 'managed' }), { Type: 'UNMANAGED' }, emptySchema))
          .declared
      ).toEqual(['Type']);
    });
  });

  // Found live by the apigwv2-http-rich bug-hunt fixture: AWS lowercases CORS
  // header names (case-insensitive per RFC 9110), so a declared
  // `AllowHeaders: ["Content-Type","Authorization"]` read back as
  // `["content-type","authorization"]` false-flagged declared drift.
  describe('case-insensitive header-name array path (apigwv2 CORS AllowHeaders/ExposeHeaders)', () => {
    const T = 'AWS::ApiGatewayV2::Api';
    const cors = (headers: string[]) => ({
      CorsConfiguration: { AllowHeaders: headers, AllowMethods: ['GET', 'POST'] },
    });

    it('mixed-case declared vs lowercase live CORS AllowHeaders is NOT drift', () => {
      expect(
        classifyResource(
          res(T, cors(['Content-Type', 'Authorization'])),
          cors(['content-type', 'authorization']),
          emptySchema
        )
      ).toEqual([]);
    });

    it('a header set in a different order is NOT drift (unordered)', () => {
      expect(
        classifyResource(
          res(T, cors(['Content-Type', 'Authorization'])),
          cors(['authorization', 'content-type']),
          emptySchema
        )
      ).toEqual([]);
    });

    it('a genuinely changed header (same length) is still drift', () => {
      expect(
        tiers(
          classifyResource(
            res(T, cors(['Content-Type', 'Authorization'])),
            cors(['content-type', 'x-api-key']),
            emptySchema
          )
        ).declared
      ).toEqual(['CorsConfiguration.AllowHeaders']);
    });

    it('ExposeHeaders is folded case-insensitively too', () => {
      const expose = (h: string[]) => ({ CorsConfiguration: { ExposeHeaders: h } });
      expect(
        classifyResource(
          res(T, expose(['X-Custom', 'X-Total'])),
          expose(['x-total', 'x-custom']),
          emptySchema
        )
      ).toEqual([]);
    });

    it('the header-fold rule is scoped per-type+path (other string arrays stay strict)', () => {
      expect(
        tiers(
          classifyResource(
            res('AWS::S3::Bucket', { CorsConfiguration: { AllowHeaders: ['Content-Type'] } }),
            { CorsConfiguration: { AllowHeaders: ['content-type'] } },
            emptySchema
          )
        ).declared
      ).toEqual(['CorsConfiguration.AllowHeaders']);
    });
  });

  // Found live by the apigwv2-http-rich bug-hunt fixture: the CDK HttpApi $default
  // stage runs AutoDeploy=true, so AWS mints (and re-mints on every auto-deploy) the
  // stage's DeploymentId. It is live-only (the user can't declare it under AutoDeploy),
  // so without folding it records as undeclared, churns into a false drift after any
  // out-of-band API edit, and a revert of it FAILS ("Deployment ID cannot be set ...
  // because AutoDeploy is enabled") so the stack never converges.
  describe('value-independent generated top-level path (apigwv2 AutoDeploy Stage DeploymentId)', () => {
    const T = 'AWS::ApiGatewayV2::Stage';
    const stage = (deploymentId: string) => ({
      StageName: '$default',
      AutoDeploy: true,
      DeploymentId: deploymentId,
    });

    it('a live-only AutoDeploy Stage DeploymentId folds as generated (not undeclared/drift)', () => {
      const t = tiers(
        classifyResource(
          res(T, { StageName: '$default', AutoDeploy: true }),
          stage('abc123def'),
          emptySchema
        )
      );
      expect(t.generated).toEqual(['DeploymentId']);
      expect(t.undeclared).toEqual([]);
    });

    it('a DIFFERENT generated id still folds (value-independent — it churns)', () => {
      const t = tiers(
        classifyResource(
          res(T, { StageName: '$default', AutoDeploy: true }),
          stage('zzz999new'),
          emptySchema
        )
      );
      expect(t.generated).toEqual(['DeploymentId']);
      expect(t.undeclared).toEqual([]);
    });

    it('the fold is scoped per-type (a DeploymentId on another type stays undeclared)', () => {
      expect(
        tiers(
          classifyResource(res('AWS::S3::Bucket', {}), { DeploymentId: 'abc123def' }, emptySchema)
        ).undeclared
      ).toEqual(['DeploymentId']);
    });
  });

  // Found live by the synthetics-rich bug-hunt fixture: AWS Synthetics rewrites a
  // canary's rate() schedule to whole units (CDK emits `rate(60 minutes)` from
  // Duration.hours(1); AWS returns `rate(1 hour)`), false-flagging declared drift.
  describe('rate() schedule-expression equivalence (Synthetics Canary Schedule.Expression)', () => {
    const T = 'AWS::Synthetics::Canary';
    const sched = (expr: string) => ({ Schedule: { Expression: expr } });

    it('rate(60 minutes) vs rate(1 hour) is NOT drift (same duration)', () => {
      expect(
        classifyResource(res(T, sched('rate(60 minutes)')), sched('rate(1 hour)'), emptySchema)
      ).toEqual([]);
    });

    it('rate(1440 minutes) vs rate(1 day) is NOT drift', () => {
      expect(
        classifyResource(res(T, sched('rate(1440 minutes)')), sched('rate(1 day)'), emptySchema)
      ).toEqual([]);
    });

    it('a genuinely different interval is still drift', () => {
      expect(
        tiers(classifyResource(res(T, sched('rate(1 hour)')), sched('rate(2 hours)'), emptySchema))
          .declared
      ).toEqual(['Schedule.Expression']);
    });

    it('a cron() expression is compared strictly (only rate() is folded)', () => {
      expect(
        tiers(
          classifyResource(
            res(T, sched('cron(0 10 * * ? *)')),
            sched('cron(0 12 * * ? *)'),
            emptySchema
          )
        ).declared
      ).toEqual(['Schedule.Expression']);
    });

    it('the rate fold is scoped per-type+path (other types stay strict)', () => {
      expect(
        tiers(
          classifyResource(
            res('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(60 minutes)' }),
            { ScheduleExpression: 'rate(1 hour)' },
            emptySchema
          )
        ).declared
      ).toEqual(['ScheduleExpression']);
    });
  });

  // AppSync ApiKey Expires is an epoch-seconds timestamp AWS rounds DOWN to the hour,
  // so a template's exact epoch reads back as the hour floor — a false declared drift.
  describe('epoch-hour equivalence (AppSync ApiKey Expires)', () => {
    const T = 'AWS::AppSync::ApiKey';
    it('same hour (declared exact vs live hour-floor) is NOT drift', () => {
      // 1784632175 floors to 1784631600 (the hour) — same hour, not drift.
      expect(
        classifyResource(res(T, { Expires: 1784632175 }), { Expires: 1784631600 }, emptySchema)
      ).toEqual([]);
    });
    it('a different hour IS drift', () => {
      expect(
        tiers(
          classifyResource(res(T, { Expires: 1784631600 }), { Expires: 1784638800 }, emptySchema)
        ).declared
      ).toEqual(['Expires']);
    });
    it('the epoch-hour fold is scoped per-type+path (other types stay strict)', () => {
      expect(
        tiers(
          classifyResource(
            res('AWS::S3::Bucket', { Expires: 1784632175 }),
            { Expires: 1784631600 },
            emptySchema
          )
        ).declared
      ).toEqual(['Expires']);
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

  describe('ELBv2 ListenerRule Conditions (reordered set, found by elbv2-listenerrule-rich)', () => {
    const T = 'AWS::ElasticLoadBalancingV2::ListenerRule';
    const declared = {
      Conditions: [
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*', '/v2/*'] } },
        { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Custom', Values: ['a'] } },
      ],
    };

    it('AWS returning the Conditions in a different order is NOT drift', () => {
      const live = {
        Conditions: [
          { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Custom', Values: ['a'] } },
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*', '/v2/*'] } },
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine condition value change still surfaces (even when reordered)', () => {
      const live = {
        Conditions: [
          { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Custom', Values: ['a'] } },
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/changed/*', '/v2/*'] } },
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('Bedrock Guardrail nested policy-config arrays (reordered, found by bedrock-guardrail-rich)', () => {
    const T = 'AWS::Bedrock::Guardrail';
    const declared = {
      ContentPolicyConfig: {
        FiltersConfig: [
          { Type: 'HATE', InputStrength: 'HIGH', OutputStrength: 'HIGH' },
          { Type: 'VIOLENCE', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' },
        ],
      },
    };

    it('AWS returning the nested FiltersConfig in a different order is NOT drift', () => {
      const live = {
        ContentPolicyConfig: {
          FiltersConfig: [
            { Type: 'VIOLENCE', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' },
            { Type: 'HATE', InputStrength: 'HIGH', OutputStrength: 'HIGH' },
          ],
        },
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine filter strength change still surfaces (even when reordered)', () => {
      const live = {
        ContentPolicyConfig: {
          FiltersConfig: [
            { Type: 'VIOLENCE', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' },
            { Type: 'HATE', InputStrength: 'LOW', OutputStrength: 'HIGH' }, // HIGH -> LOW
          ],
        },
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });
});

describe('LATEST sentinel declared false positives (Fargate PlatformVersion, found by ecs-taskset-rich)', () => {
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

  // The fold must hold for EVERY type that declares a Fargate PlatformVersion.
  for (const T of ['AWS::ECS::TaskSet', 'AWS::ECS::Service']) {
    describe(T, () => {
      it('declared "LATEST" resolved to a concrete version is NOT drift', () => {
        expect(
          declaredTiers(T, { PlatformVersion: 'LATEST' }, { PlatformVersion: '1.4.0' })
        ).toEqual([]);
      });

      it('a declared CONCRETE version that differs still surfaces (no over-fold)', () => {
        expect(
          declaredTiers(T, { PlatformVersion: '1.3.0' }, { PlatformVersion: '1.4.0' }).length
        ).toBeGreaterThan(0);
      });

      it('an empty live value is still a real divergence', () => {
        expect(
          declaredTiers(T, { PlatformVersion: 'LATEST' }, { PlatformVersion: '' }).length
        ).toBeGreaterThan(0);
      });
    });
  }
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

  it('ELB attribute bags: declared keys subset-compared (no false drift), live-only keys emitted as undeclared (R95 fail-closed)', () => {
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
    const findings = classifyResource(res(T, declared), liveAll, emptySchema);
    // the 2 declared keys match -> NO declared (false) drift
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // the live-only keys are now undeclared inventory (R95: additions reported, not hidden)
    expect(
      findings
        .filter((f) => f.tier === 'undeclared')
        .map((f) => f.path)
        .sort()
    ).toEqual([
      'LoadBalancerAttributes[access_logs.s3.enabled]',
      'LoadBalancerAttributes[routing.http2.enabled]',
    ]);
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

  // Live-observed FP (neptune-rich fixture): Neptune accepts a major.minor
  // EngineVersion and reads back the concrete 4-segment patch it provisioned.
  it('Neptune DBCluster EngineVersion "1.3" resolved to live "1.3.5.0" is NOT declared drift', () => {
    expect(
      declaredPaths(
        'AWS::Neptune::DBCluster',
        { EngineVersion: '1.3' },
        { EngineVersion: '1.3.5.0' }
      )
    ).toEqual([]);
    // a genuine track change still differs
    expect(
      declaredPaths(
        'AWS::Neptune::DBCluster',
        { EngineVersion: '1.2' },
        { EngineVersion: '1.3.5.0' }
      )
    ).toEqual(['EngineVersion']);
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

// AWS::IAM::ManagedPolicy Roles/Users/Groups are tiered per member: a DECLARED member
// removed out of band IS reported (detach, declared tier), while a live-only member
// (the union — the same policy attached elsewhere) surfaces as UNDECLARED inventory
// (recordable) — not a positional FP, and not dropped, so a NEW unexpected attachment
// later surfaces as drift vs the baseline. Better than the old "don't compare" boundary
// (missed the detach), the first cut (dropped the union, missed an unexpected attach),
// and cdk drift (false-drifts the whole union).
describe('IAM ManagedPolicy attachment tiering (declared detach + undeclared union)', () => {
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
  const mp = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'MP',
    resourceType: 'AWS::IAM::ManagedPolicy',
    physicalId: 'arn:aws:iam::111122223333:policy/p',
    declared,
  });

  it('reports a declared Role removed from the live attachment set (detach)', () => {
    const f = classifyResource(
      mp({ Roles: ['RoleA', 'RoleB'] }),
      { Roles: ['RoleA'] },
      emptySchema
    );
    const detach = f.filter((x) => x.tier === 'declared' && x.path === 'Roles');
    expect(detach).toHaveLength(1);
    expect(detach[0]?.attributeKey).toBe('RoleB');
    expect(detach[0]?.desired).toBe('RoleB');
    expect(detach[0]?.actual).toBeUndefined();
  });

  it('reports a live-only attachment as UNDECLARED inventory (recordable), not declared drift', () => {
    // declared RoleA still attached; RoleX attached elsewhere (role-side ManagedPolicyArns
    // or the console) — the union member is NOT a declared FP, but it IS surfaced as
    // undeclared inventory so it can be recorded and a NEW attachment later drifts.
    const f = classifyResource(
      mp({ Roles: ['RoleA'] }),
      { Roles: ['RoleA', 'RoleX'] },
      emptySchema
    );
    expect(f.filter((x) => x.tier === 'declared')).toEqual([]); // RoleA present -> no detach
    const undeclared = f.filter((x) => x.tier === 'undeclared');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatchObject({ path: 'Roles[RoleX]', actual: 'RoleX', nested: true });
  });

  it('declared members CLEAN; every extra union member surfaces as undeclared inventory', () => {
    const f = classifyResource(
      mp({ Roles: ['RoleA'], Users: ['UserA'], Groups: ['GroupA'] }),
      { Roles: ['RoleA', 'RoleX'], Users: ['UserA'], Groups: ['GroupA', 'GroupZ'] },
      emptySchema
    );
    expect(tiers(f).declared).toEqual([]); // all declared members present
    expect(tiers(f).undeclared).toEqual(['Groups[GroupZ]', 'Roles[RoleX]']); // the union extras
  });

  it('handles Users and Groups detach independently, one finding per missing member', () => {
    const f = classifyResource(
      mp({ Roles: ['RoleA'], Users: ['UserA', 'UserB'], Groups: ['GroupA'] }),
      { Roles: ['RoleA'], Users: [], Groups: [] },
      emptySchema
    );
    const detached = f
      .filter((x) => x.tier === 'declared')
      .map((x) => `${x.path}[${x.attributeKey}]`)
      .sort();
    expect(detached).toEqual(['Groups[GroupA]', 'Users[UserA]', 'Users[UserB]']);
  });

  it('a NON-declared live attachment list surfaces as undeclared inventory (recordable)', () => {
    // template declares no Roles at all; the policy is attached to a role elsewhere.
    // It is NOT dropped (that hid an unexpected attachment) — it flows to the undeclared
    // loop as ordinary undeclared inventory so it can be recorded + watched.
    const f = classifyResource(
      mp({ Description: '' }),
      { Roles: ['RoleX'], Description: '' },
      emptySchema
    );
    const undeclared = f.filter((x) => x.tier === 'undeclared');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatchObject({ path: 'Roles', actual: ['RoleX'] });
    expect(f.some((x) => x.tier === 'declared')).toBe(false);
  });

  it('skips an UNRESOLVED declared member (an intrinsic) rather than false-drifting it', () => {
    const f = classifyResource(
      mp({ Roles: ['RoleA', UNRESOLVED] }),
      { Roles: ['RoleA'] },
      emptySchema
    );
    // the whole property is noted unresolved; no per-member detach for the symbol, and
    // RoleA (present) is not a detach either.
    expect(f.filter((x) => x.tier === 'declared' && x.path === 'Roles')).toEqual([]);
    expect(f.some((x) => x.tier === 'unresolved' && x.path === 'Roles')).toBe(true);
  });

  it('still reports a RESOLVED detached member even when a SIBLING member is unresolved', () => {
    const f = classifyResource(
      mp({ Roles: ['RoleA', UNRESOLVED] }),
      { Roles: [] }, // RoleA detached out of band
      emptySchema
    );
    const detach = f.filter((x) => x.tier === 'declared' && x.attributeKey === 'RoleA');
    expect(detach).toHaveLength(1);
  });

  it('an EMPTY declared list reports no detach; live union members are undeclared inventory', () => {
    // an empty declared Roles has nothing to detach; the live members are all the union.
    const f = classifyResource(mp({ Roles: [] }), { Roles: ['RoleX', 'RoleY'] }, emptySchema);
    expect(tiers(f).declared).toEqual([]);
    expect(tiers(f).undeclared).toEqual(['Roles[RoleX]', 'Roles[RoleY]']);
  });

  it('reports a detach AND an unexpected attach at once (declared RoleA gone, RoleB appeared)', () => {
    const f = classifyResource(mp({ Roles: ['RoleA'] }), { Roles: ['RoleB'] }, emptySchema);
    const detach = f.filter((x) => x.tier === 'declared' && x.path === 'Roles');
    expect(detach).toHaveLength(1);
    expect(detach[0]?.attributeKey).toBe('RoleA'); // declared member removed
    const undeclared = f.filter((x) => x.tier === 'undeclared');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatchObject({ path: 'Roles[RoleB]', actual: 'RoleB', nested: true }); // unexpected attach
  });

  it('reports EVERY declared member when all three lists are fully detached (live all empty)', () => {
    const f = classifyResource(
      mp({ Roles: ['R1', 'R2'], Users: ['U1'], Groups: ['G1', 'G2'] }),
      { Roles: [], Users: [], Groups: [] },
      emptySchema
    );
    const detached = f
      .filter((x) => x.tier === 'declared')
      .map((x) => `${x.path}[${x.attributeKey}]`)
      .sort();
    expect(detached).toEqual(['Groups[G1]', 'Groups[G2]', 'Roles[R1]', 'Roles[R2]', 'Users[U1]']);
  });

  it('matches members by exact NAME (the CFn attachment-list shape) — same names are CLEAN', () => {
    // CFn Roles/Users/Groups are role/user/group NAMES (a Ref to a Role resolves to its
    // name); the live ListEntitiesForPolicy read returns names too — exact-name compare.
    const f = classifyResource(
      mp({ Roles: ['my-app-role'] }),
      { Roles: ['my-app-role'] },
      emptySchema
    );
    expect(tiers(f).declared).toEqual([]);
  });

  it('surfaces a document drift AND an attachment detach together (independent findings)', () => {
    const f = classifyResource(
      mp({
        Roles: ['RoleA'],
        Description: 'intended',
      }),
      { Roles: [], Description: 'tampered' },
      emptySchema
    );
    const declared = f.filter((x) => x.tier === 'declared');
    expect(declared.some((x) => x.path === 'Roles' && x.attributeKey === 'RoleA')).toBe(true);
    expect(declared.some((x) => x.path === 'Description')).toBe(true);
    expect(declared).toHaveLength(2);
  });

  it('does NOT touch a different resource type that happens to have a Roles property', () => {
    // the asymmetric handler is scoped to AWS::IAM::ManagedPolicy only; another type's
    // `Roles` array compares normally (a symmetric declared diff), not asymmetrically.
    const res: DesiredResource = {
      logicalId: 'X',
      resourceType: 'AWS::SomeOther::Type',
      physicalId: 'x',
      declared: { Roles: ['A'] },
    };
    const f = classifyResource(res, { Roles: ['A', 'B'] }, emptySchema);
    // symmetric compare: the extra live element IS a declared-array diff (not suppressed)
    expect(f.some((x) => x.tier === 'declared' && x.path === 'Roles')).toBe(true);
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

describe('EC2 Instance BlockDeviceMappings identity-keyed subset (found by ec2-instance-rich)', () => {
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
  const inst = (declared: Record<string, unknown>) => ({
    logicalId: 'Host',
    resourceType: 'AWS::EC2::Instance',
    physicalId: 'i-0abc',
    declared,
  });
  // The template declares only the root mapping with a minimal Ebs block.
  const declaredRoot = {
    DeviceName: '/dev/xvda',
    Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 8, VolumeType: 'gp3' },
  };
  // AWS enriches the matching live mapping with defaults the template never set
  // (SnapshotId, the encrypting KmsKeyId, the resolved Iops) and may reorder the keys.
  const liveRoot = {
    Ebs: {
      SnapshotId: 'snap-08bb176df19e6f6ca',
      VolumeType: 'gp3',
      KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc',
      Encrypted: true,
      Iops: 3000,
      VolumeSize: 8,
      DeleteOnTermination: true,
    },
    DeviceName: '/dev/xvda',
  };
  // A volume attached out of band / via a sibling VolumeAttachment appears as an EXTRA
  // live mapping the Instance template never declared.
  const liveAttached = {
    Ebs: {
      SnapshotId: '',
      VolumeType: 'gp3',
      KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc',
      Encrypted: true,
      Iops: 3000,
      VolumeSize: 10,
      DeleteOnTermination: false,
    },
    DeviceName: '/dev/sdf',
  };

  it('a subset root mapping + an extra live mapping does NOT false-drift the whole array', () => {
    const findings = classifyResource(
      inst({ BlockDeviceMappings: [declaredRoot] }),
      { BlockDeviceMappings: [liveRoot, liveAttached] },
      bare
    );
    // the enriched Ebs keys + the extra /dev/sdf mapping must NOT be a declared drift
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // the live-only mapping surfaces as nested undeclared inventory, keyed by DeviceName
    const undeclared = findings.filter(
      (f) => f.tier === 'undeclared' && f.path === 'BlockDeviceMappings[/dev/sdf]'
    );
    expect(undeclared).toHaveLength(1);
  });

  it('an out-of-band change to a DECLARED Ebs sub-value is reported as declared drift', () => {
    const declaredDrift = classifyResource(
      inst({ BlockDeviceMappings: [declaredRoot] }),
      // root volume grown out of band 8 -> 16
      {
        BlockDeviceMappings: [
          { ...liveRoot, Ebs: { ...liveRoot.Ebs, VolumeSize: 16 } },
          liveAttached,
        ],
      },
      bare
    ).filter((f) => f.tier === 'declared');
    expect(declaredDrift).toHaveLength(1);
    expect(declaredDrift[0]).toMatchObject({
      path: 'BlockDeviceMappings.0.Ebs.VolumeSize',
      desired: 8,
      actual: 16,
    });
  });

  it('a declared mapping absent from live (DeviceName removed) is declared drift', () => {
    const declaredDrift = classifyResource(
      inst({ BlockDeviceMappings: [declaredRoot] }),
      { BlockDeviceMappings: [liveAttached] }, // /dev/xvda no longer present
      bare
    ).filter((f) => f.tier === 'declared');
    expect(declaredDrift).toHaveLength(1);
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

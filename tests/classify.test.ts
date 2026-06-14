import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
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

describe('KNOWN_DEFAULTS suppression (R66 — dogfood-observed service defaults)', () => {
  const emptySchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
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
      expect(declaredF.map((f) => f.attributeKey).sort()).toEqual([
        'deletion_protection.enabled',
        'idle_timeout.timeout_seconds',
      ]);
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

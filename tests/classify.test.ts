import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, matchesKnownDefault, normalizeLiveModel } from '../src/diff/classify.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import {
  ebOptionSettingTier,
  IDENTITY_KEYED_DEFAULT_ELEMENTS,
  KNOWN_DEFAULT_PATHS,
  KNOWN_DEFAULTS,
} from '../src/normalize/noise.js';
import { buildRevertPlan } from '../src/revert/plan.js';
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

  // Reported bug: CloudFormation's GetTemplate masks every non-ASCII char in a stored
  // string literal as `?`. We fetch the declared side via GetTemplate, so an SSM
  // Parameter `Value: áéíóúABC` comes back declared `?????ABC` while the live SSM
  // value is intact — a false `declared` drift on every clean deploy. The masked-equal
  // declared value is unverifiable → surface it as a readGap, never declared drift.
  it('GetTemplate `?`-masked non-ASCII declared value is a readGap, not declared drift', () => {
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
      logicalId: 'GreetingParameter',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'p-phys',
      declared: { Value: '?????ABC' }, // masked by GetTemplate
    };
    const t = tiers(classifyResource(res, { Value: 'áéíóúABC' }, emptySchema));
    expect(t.declared).toEqual([]); // not a false drift
    expect(t.readGap).toEqual(['Value']); // surfaced honestly instead
    // A genuine ASCII change (or length change) is NOT masked-equal → still declared drift.
    const drifted = tiers(classifyResource(res, { Value: 'áéíóúABCX' }, emptySchema));
    expect(drifted.declared).toEqual(['Value']);
  });

  // Reported bug: EventBridge Scheduler declares `Target.SqsParameters: {}` (an empty
  // optional sub-config), but the live read OMITS the key entirely — the drift-calculator
  // emits a per-leaf record `Target.SqsParameters` with desired `{}` / actual undefined,
  // false-flagging every clean deploy as declared drift. A NESTED declared trivially-empty
  // value whose live counterpart is absent (or equally empty) is not drift.
  it('nested declared empty sub-object vs absent live is not drift (Scheduler SqsParameters)', () => {
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
      logicalId: 'Scheduler',
      resourceType: 'AWS::Scheduler::Schedule',
      physicalId: 'sched-phys',
      declared: {
        Target: { Arn: 'arn:aws:lambda:...', RoleArn: 'arn:aws:iam:...', SqsParameters: {} },
      },
    };
    // Live omits the empty SqsParameters entirely — no declared drift.
    const clean = tiers(
      classifyResource(
        res,
        { Target: { Arn: 'arn:aws:lambda:...', RoleArn: 'arn:aws:iam:...' } },
        emptySchema
      )
    );
    expect(clean.declared).toEqual([]);
  });

  // The empty-vs-absent fold is gated on the DECLARED side being trivially empty: a
  // declared EMPTY collection the live read POPULATED out of band is still real drift.
  it('nested declared empty collection vs a populated live value still surfaces as drift', () => {
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
      logicalId: 'Widget',
      resourceType: 'AWS::Example::Widget',
      physicalId: 'w-phys',
      declared: { Config: { Name: 'w', Items: [] } }, // declared empty list
    };
    const drifted = tiers(
      classifyResource(res, { Config: { Name: 'w', Items: ['x', 'y'] } }, emptySchema)
    );
    expect(drifted.declared).toEqual(['Config.Items']);
  });

  // A CloudFormation JSON-STRING property (AWS::Config::ConfigRule InputParameters):
  // CDK declares it as an object, Cloud Control returns it parsed. It must be compared
  // and reported as a WHOLE UNIT at the top-level path — never descended — so the revert
  // can rewrite it as a compact JSON string instead of a sub-path patch the provider
  // rejects. A stringly-equal value (declared `90` vs live `"90"`, the param-values-are-
  // strings coercion) is folded; a real value change is one declared finding at the
  // top-level path (NOT the nested `InputParameters.maxAccessKeyAge`).
  it('JSON-string property (ConfigRule InputParameters): clean folds, change is one top-level finding', () => {
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
      logicalId: 'Rule',
      resourceType: 'AWS::Config::ConfigRule',
      physicalId: 'cdkrd-access-keys-rotated',
      declared: { InputParameters: { maxAccessKeyAge: 90 } }, // CDK declares a number
    };
    // Clean: live param values are strings (`"90"`) — stringly-equal, not drift.
    const clean = tiers(
      classifyResource(res, { InputParameters: { maxAccessKeyAge: '90' } }, emptySchema)
    );
    expect(clean.declared).toEqual([]);
    expect(clean.undeclared).toEqual([]); // never descended into a fragile nested finding
    // Weakened out of band (90 -> 365): ONE declared finding at the WHOLE property path.
    const drifted = classifyResource(
      res,
      { InputParameters: { maxAccessKeyAge: '365' } },
      emptySchema
    );
    const declared = drifted.filter((f) => f.tier === 'declared');
    expect(declared).toHaveLength(1);
    expect(declared[0].path).toBe('InputParameters'); // top-level, NOT InputParameters.maxAccessKeyAge
    expect(declared[0].desired).toEqual({ maxAccessKeyAge: 90 });
    expect(declared[0].actual).toEqual({ maxAccessKeyAge: '365' });
    // also returned as a raw JSON string by some providers — still folded/compared whole.
    const asString = tiers(
      classifyResource(res, { InputParameters: '{"maxAccessKeyAge":"90"}' }, emptySchema)
    );
    expect(asString.declared).toEqual([]);
  });

  // #503: CE CostCategory Rules is a JSON-STRING prop; the service injects `"Type":"REGULAR"`
  // (the default rule type) into every rule, so a clean deploy reported permanent declared
  // drift. The values arrive as canonicalized JSON strings (normalize runs before classify).
  it('JSON-string default-fill (CostCategory Rules Type:REGULAR): clean folds, non-default surfaces', () => {
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
      logicalId: 'CostCat',
      resourceType: 'AWS::CE::CostCategory',
      physicalId: 'arn:aws:ce::111111111111:costcategory/abc',
      declared: {
        Rules:
          '[{"Rule":{"Dimensions":{"Key":"SERVICE_CODE","Values":["AmazonS3"]}},"Value":"storage"}]',
      },
    };
    // Clean: live is identical except the service-injected Type:"REGULAR" per rule.
    const clean = tiers(
      classifyResource(
        res,
        {
          Rules:
            '[{"Rule":{"Dimensions":{"Key":"SERVICE_CODE","Values":["AmazonS3"]}},"Type":"REGULAR","Value":"storage"}]',
        },
        emptySchema
      )
    );
    expect(clean.declared).toEqual([]);
    // A rule whose Type is a NON-default value is not stripped -> still surfaces as drift.
    const drifted = tiers(
      classifyResource(
        res,
        {
          Rules:
            '[{"Rule":{"Dimensions":{"Key":"SERVICE_CODE","Values":["AmazonS3"]}},"Type":"INHERITED_VALUE","Value":"storage"}]',
        },
        emptySchema
      )
    );
    expect(drifted.declared).toEqual(['Rules']);
    // A genuine dimension change still surfaces even though Type:REGULAR is present.
    const valueChange = tiers(
      classifyResource(
        res,
        {
          Rules:
            '[{"Rule":{"Dimensions":{"Key":"SERVICE_CODE","Values":["AmazonEC2"]}},"Type":"REGULAR","Value":"storage"}]',
        },
        emptySchema
      )
    );
    expect(valueChange.declared).toEqual(['Rules']);
  });

  // First-run noise folds for a clean deploy: a Cognito user pool
  // ALWAYS returns the immutable OIDC standard attributes in Schema (fold to atDefault via
  // IDENTITY_KEYED_DEFAULT_ELEMENTS) and a Lambda Version's CodeSha256 is a per-deploy
  // content hash (fold to generated via GENERATED_TOPLEVEL_PATHS).
  it('Cognito standard Schema attrs fold to atDefault; a customized one still surfaces', () => {
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
    const stdEmail = {
      AttributeDataType: 'String',
      DeveloperOnlyAttribute: false,
      Mutable: true,
      Name: 'email',
      Required: false,
      StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
    };
    const res: DesiredResource = {
      logicalId: 'Pool',
      resourceType: 'AWS::Cognito::UserPool',
      physicalId: 'us-east-1_x',
      declared: { Schema: [{ Name: 'custom:tenant', AttributeDataType: 'String', Mutable: true }] },
    };
    // a live-only standard attr at its default shape → atDefault (folded, not undeclared)
    const t = tiers(classifyResource(res, { Schema: [stdEmail] }, emptySchema));
    expect(t.atDefault).toEqual(['Schema[email]']);
    expect(t.undeclared).toEqual([]);
    // a standard attr AWS returns at a NON-default shape (e.g. made Required) still surfaces
    const customized = { ...stdEmail, Required: true };
    const t2 = tiers(classifyResource(res, { Schema: [customized] }, emptySchema));
    expect(t2.undeclared).toEqual(['Schema[email]']);
    expect(t2.atDefault).toEqual([]);
  });

  it('Lambda Version CodeSha256 folds to generated; RuntimePolicy Auto folds to atDefault', () => {
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
      logicalId: 'Ver',
      resourceType: 'AWS::Lambda::Version',
      physicalId: '1',
      declared: { FunctionName: 'fn' },
    };
    const t = tiers(
      classifyResource(
        res,
        { FunctionName: 'fn', CodeSha256: 'abc123=', RuntimePolicy: { UpdateRuntimeOn: 'Auto' } },
        emptySchema
      )
    );
    expect(t.generated).toEqual(['CodeSha256']); // content hash, never drift
    expect(t.atDefault).toEqual(['RuntimePolicy']);
    expect(t.undeclared).toEqual([]);
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

// The sibling-managed inline Policies mechanism is NOT Role-only: an AWS::IAM::Policy also
// attaches to Users and Groups (via its Users / Groups ref lists), the same CDK
// `<Principal>DefaultPolicy` shape. Observed live on my-app-Pipeline: a data-transfer IAM
// User read back Path:'/' + an inline Policies entry owned by its sibling DefaultPolicy →
// two false undeclared drifts. Path is the IAM default (KNOWN_DEFAULTS); the Policies entry
// is dropped by the sibling filter now that siblingPolicyNames is plumbed for Users/Groups.
describe('sibling-managed inline Policies (IAM User / Group)', () => {
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
    Statement: [
      { Effect: 'Allow', Action: ['s3:GetBucket*', 's3:GetObject*', 's3:List*'], Resource: '*' },
    ],
  };
  // db2bq's real live shape: PolicyName === the sibling AWS::IAM::Policy's literal name.
  const sibling = { PolicyName: 'DataTransferIamUserDefaultPolicy758350EB', PolicyDocument: DOC };
  const rogue = { PolicyName: 'rogue-inline', PolicyDocument: DOC };
  const principal = (
    resourceType: string,
    siblingPolicyNames?: string[] | 'unresolved',
    declared: Record<string, unknown> = {}
  ): DesiredResource => ({
    logicalId: 'P',
    resourceType,
    physicalId: 'principal-name',
    declared,
    siblingPolicyNames,
  });

  it('IAM User: Path:/ folds atDefault and the sibling-owned Policies entry is filtered out', () => {
    const t = tiers(
      classifyResource(
        principal('AWS::IAM::User', ['DataTransferIamUserDefaultPolicy758350EB']),
        { Path: '/', Policies: [sibling] },
        noSchema
      )
    );
    expect(t.atDefault).toEqual(['Path']);
    expect(t.undeclared).toEqual([]);
  });

  it('IAM Group: Path:/ folds atDefault and the sibling-owned Policies entry is filtered out', () => {
    const t = tiers(
      classifyResource(
        principal('AWS::IAM::Group', ['DataTransferIamUserDefaultPolicy758350EB']),
        { Path: '/', Policies: [sibling] },
        noSchema
      )
    );
    expect(t.atDefault).toEqual(['Path']);
    expect(t.undeclared).toEqual([]);
  });

  it('IAM User: an out-of-band inline policy next to a sibling still surfaces as undeclared', () => {
    const findings = classifyResource(
      principal('AWS::IAM::User', ['DataTransferIamUserDefaultPolicy758350EB']),
      { Policies: [sibling, rogue] },
      noSchema
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tier: 'undeclared', path: 'Policies' });
    const actual = findings[0]!.actual as { PolicyName: string }[];
    expect(actual.map((p) => p.PolicyName)).toEqual(['rogue-inline']);
  });

  it('IAM User: an UNRESOLVED sibling stamps the revert-hazard marker on a declared Policies finding', () => {
    const declared = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }] };
    const live = { Policies: [{ PolicyName: 'inline-a', PolicyDocument: DOC }, sibling] };
    const findings = classifyResource(
      principal('AWS::IAM::User', 'unresolved', declared),
      live,
      noSchema
    );
    const f = findings.find((x) => x.path === 'Policies');
    expect(f).toBeDefined();
    expect(f!.siblingPolicyNames).toBe('unresolved');
  });
});

// An ECS Cluster reflects the CapacityProviders / DefaultCapacityProviderStrategy declared by
// its sibling AWS::ECS::ClusterCapacityProviderAssociations resource (the only CFn way to set
// them), plus ClusterSettings:[{containerInsights,disabled}] (the AWS default). Observed live on
// my-app-Pipeline: 3 false undeclared drifts on every Fargate cluster. ClusterSettings folds as a
// KNOWN_DEFAULT; the two reflected props are dropped when a sibling association is present.
describe('ECS Cluster sibling capacity providers + ClusterSettings default (my-app-Pipeline)', () => {
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
  const cluster = (hasSiblingCapacityProviders?: boolean): DesiredResource => ({
    logicalId: 'Cluster',
    resourceType: 'AWS::ECS::Cluster',
    physicalId: 'cluster-name',
    declared: {},
    hasSiblingCapacityProviders,
  });
  // the exact live model db2bq's cluster read back (key order as CC returned it)
  const live = {
    ClusterSettings: [{ Value: 'disabled', Name: 'containerInsights' }],
    CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    DefaultCapacityProviderStrategy: [
      { CapacityProvider: 'FARGATE', Weight: 0, Base: 0 },
      { CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 0 },
    ],
  };

  it('with a sibling association: all three read as clean (ClusterSettings=default, providers dropped)', () => {
    const t = tiers(classifyResource(cluster(true), structuredClone(live), noSchema));
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toEqual(['ClusterSettings']);
  });

  it('without a sibling association: the capacity providers DO surface (the guard is load-bearing)', () => {
    const t = tiers(classifyResource(cluster(false), structuredClone(live), noSchema));
    expect(t.undeclared).toEqual(['CapacityProviders', 'DefaultCapacityProviderStrategy']);
    // ClusterSettings still folds as a default regardless of the sibling flag
    expect(t.atDefault).toEqual(['ClusterSettings']);
  });

  it('an enabled ClusterSettings is NOT the default and surfaces (equality-gated)', () => {
    const enabled = {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
    };
    const t = tiers(classifyResource(cluster(true), enabled, noSchema));
    expect(t.undeclared).toEqual(['ClusterSettings']);
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

  it('#624 general: a fully-undeclared object whose every leaf is a schema nested default folds whole atDefault; anything else surfaces', () => {
    // The general fail-closed rule that closes the fully-undeclared-object gap (KinesisVideo
    // StreamStorageConfiguration, Lambda CodeSigningConfig CodeSigningPolicies) for ANY type
    // whose schema annotates the nested defaults — no per-type DESCEND entry needed.
    const schema: SchemaInfo = {
      ...emptySchema,
      defaultPaths: { 'Conf.Tier': 'HOT', 'Conf.Nested.Mode': 'A' },
    };
    const t = (live: Record<string, unknown>) =>
      tiers(classifyResource(bare('AWS::X::Y'), live, schema));
    // every leaf (incl. a deeper nested one) at its schema default -> WHOLE object folds atDefault
    expect(t({ Conf: { Tier: 'HOT', Nested: { Mode: 'A' } } }).atDefault).toEqual(['Conf']);
    // one leaf off its default -> the whole object surfaces (fail-closed)
    expect(t({ Conf: { Tier: 'WARM', Nested: { Mode: 'A' } } }).undeclared).toEqual(['Conf']);
    // a leaf with NO schema default -> surfaces (never fold an object with a real settable value)
    expect(t({ Conf: { Tier: 'HOT', Extra: 'x' } }).undeclared).toEqual(['Conf']);
    // an array member -> not folded by this rule (conservative), surfaces
    expect(t({ Conf: { Tier: 'HOT', List: [1] } }).undeclared).toEqual(['Conf']);
  });

  it('#627: DynamoDB top-level WarmThroughput derives from ProvisionedThroughput / on-demand constant', () => {
    // a provisioned table's undeclared WarmThroughput echoes its own ProvisionedThroughput
    const t = (live: Record<string, unknown>) =>
      tiers(classifyResource(bare('AWS::DynamoDB::Table'), live, emptySchema));
    // (a bare table surfaces the undeclared ProvisionedThroughput itself too — in a real
    // template it is declared; here only the WarmThroughput fold is under test.)
    expect(
      t({
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        WarmThroughput: { ReadUnitsPerSecond: 5, WriteUnitsPerSecond: 5 },
      }).atDefault
    ).toContain('WarmThroughput');
    // a warm throughput that does NOT match the provisioned capacity still surfaces
    const nonMatch = t({
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      WarmThroughput: { ReadUnitsPerSecond: 99, WriteUnitsPerSecond: 99 },
    });
    expect(nonMatch.undeclared).toContain('WarmThroughput');
    expect(nonMatch.atDefault).not.toContain('WarmThroughput');
    // an on-demand table (no ProvisionedThroughput) folds the {12000,4000} constant
    expect(
      t({ WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }).atDefault
    ).toEqual(['WarmThroughput']);
    // the GSI-nested WarmThroughput derive (per-GSI ProvisionedThroughput / constant) is
    // exercised end-to-end by the DynamoDB OnDemandGsi/ProvGsi/CappedV2 corpus-replay cases.
  });

  it('#629: a bare Cognito UserPool folds every fully-undeclared standard Schema attribute; a custom one surfaces', () => {
    const stdEmail = IDENTITY_KEYED_DEFAULT_ELEMENTS['AWS::Cognito::UserPool']!.Schema!.email;
    const stdSub = IDENTITY_KEYED_DEFAULT_ELEMENTS['AWS::Cognito::UserPool']!.Schema!.sub;
    // a custom attribute the user added out of band (custom: prefix normalized to its bare id)
    const custom = { Name: 'custom:tier', AttributeDataType: 'String', Mutable: true };
    const t = tiers(
      classifyResource(
        bare('AWS::Cognito::UserPool'),
        { Schema: [structuredClone(stdEmail), structuredClone(stdSub), custom] },
        emptySchema
      )
    );
    expect(t.atDefault.sort()).toEqual(['Schema[email]', 'Schema[sub]']);
    expect(t.undeclared).toEqual(['Schema[tier]']); // the genuine custom attribute still surfaces
  });

  it('#626: ResourceExplorer2 View undeclared Scope folds via the context-ARN default', () => {
    const t = (live: Record<string, unknown>, opts?: Parameters<typeof classifyResource>[3]) =>
      tiers(classifyResource(bare('AWS::ResourceExplorer2::View'), live, emptySchema, opts));
    const opts = { accountId: '111111111111', region: 'us-east-1' };
    // the account-root ARN, derived from account+region+partition, folds atDefault
    expect(t({ Scope: 'arn:aws:iam::111111111111:root' }, opts).atDefault).toEqual(['Scope']);
    // a view scoped elsewhere (an OU) is NOT the default and still surfaces (equality-gated)
    expect(
      t({ Scope: 'arn:aws:organizations::111111111111:ou/o-x/ou-x' }, opts).undeclared
    ).toEqual(['Scope']);
    // China / GovCloud partitions are derived from the region prefix
    expect(
      t({ Scope: 'arn:aws-cn:iam::111111111111:root' }, { ...opts, region: 'cn-north-1' }).atDefault
    ).toEqual(['Scope']);
    // #945: ISO partitions must fold too (the CONTEXT_ARN_DEFAULTS {partition} substitution now
    // derives from partitionForRegion, not the old cn-/us-gov--only ternary that fell back to aws)
    expect(
      t({ Scope: 'arn:aws-iso:iam::111111111111:root' }, { ...opts, region: 'us-iso-east-1' })
        .atDefault
    ).toEqual(['Scope']);
    expect(
      t({ Scope: 'arn:aws-iso-e:iam::111111111111:root' }, { ...opts, region: 'eu-isoe-west-1' })
        .atDefault
    ).toEqual(['Scope']);
    // with no resolved account/region the substitution is skipped → stays undeclared, never a
    // wrong fold
    expect(t({ Scope: 'arn:aws:iam::111111111111:root' }).undeclared).toEqual(['Scope']);
  });

  it('#676: RestApi resource-policy execute-api:/* shorthand folds against the echoed full ARN', () => {
    const apiId = 'wmvd2s08ng';
    const opts = { accountId: '111111111111', region: 'us-east-1' };
    const arn = `arn:aws:execute-api:us-east-1:111111111111:${apiId}/*`;
    const res: DesiredResource = {
      logicalId: 'PrivApi',
      resourceType: 'AWS::ApiGateway::RestApi',
      physicalId: apiId,
      declared: {
        // the documented abbreviated form (CDK grantInvokeFromVpcEndpointsOnly / AWS docs)
        Policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: 'execute-api:Invoke',
              Resource: ['execute-api:/*'],
            },
            {
              Effect: 'Deny',
              Principal: '*',
              Action: 'execute-api:Invoke',
              Resource: ['execute-api:/*'],
              Condition: { StringNotEquals: { 'aws:SourceVpce': 'vpce-abc123' } },
            },
          ],
        },
      },
    };
    // clean deploy: the service echoes the shorthand back as the full ARN. Expansion makes the
    // two match -> ZERO declared drift.
    const mkLive = (resource: string) => ({
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: '*', Action: 'execute-api:Invoke', Resource: [resource] },
          {
            Effect: 'Deny',
            Principal: '*',
            Action: 'execute-api:Invoke',
            Resource: [resource],
            Condition: { StringNotEquals: { 'aws:SourceVpce': 'vpce-abc123' } },
          },
        ],
      }),
    });
    expect(tiers(classifyResource(res, mkLive(arn), emptySchema, opts)).declared).toEqual([]);
    // a policy live-repointed at a DIFFERENT api id is NOT the echo of this api's shorthand and
    // still surfaces (equality-gated — out-of-band detection preserved).
    expect(
      tiers(
        classifyResource(
          res,
          mkLive('arn:aws:execute-api:us-east-1:111111111111:OTHERAPIID/*'),
          emptySchema,
          opts
        )
      ).declared.length
    ).toBeGreaterThan(0);
    // with no resolved account the expansion is skipped -> the shorthand vs ARN still surfaces
    // (never a wrong silent fold when context is missing)
    expect(tiers(classifyResource(res, mkLive(arn), emptySchema)).declared.length).toBeGreaterThan(
      0
    );
    // #945: in an ISO region the service echoes `arn:aws-iso*:execute-api:...`; the expansion must
    // build the matching partition prefix (via partitionForRegion) so the fold still lands. Before
    // the fix the cn-/us-gov--only ternary fell back to `arn:aws:` → a first-check false drift.
    for (const [region, partition] of [
      ['us-iso-east-1', 'aws-iso'],
      ['eu-isoe-west-1', 'aws-iso-e'],
    ]) {
      const isoOpts = { accountId: '111111111111', region };
      const isoArn = `arn:${partition}:execute-api:${region}:111111111111:${apiId}/*`;
      expect(tiers(classifyResource(res, mkLive(isoArn), emptySchema, isoOpts)).declared).toEqual(
        []
      );
    }
  });

  it('#705: Classic ELB Policies folds ONLY the default SSL policy; a downgrade / added policy surfaces', () => {
    const t = (policies: unknown[]) =>
      tiers(
        classifyResource(
          bare('AWS::ElasticLoadBalancing::LoadBalancer'),
          { Policies: policies },
          emptySchema
        )
      );
    // the AWS default SSL negotiation policy — identified by PolicyName; the huge cipher
    // Attributes list is ignored (derived from the name).
    const defaultPolicy = {
      PolicyType: 'SSLNegotiationPolicyType',
      PolicyName: 'ELBSecurityPolicy-2016-08',
      Attributes: [{ Name: 'Protocol-SSLv3', Value: 'false' }],
    };
    // clean deploy: the default SSL policy folds atDefault
    expect(t([defaultPolicy]).atDefault).toEqual(['Policies']);
    // a DOWNGRADE to an older/weaker predefined policy (SSLv3 back on) SURFACES — the FN #705 fixes
    expect(
      t([
        {
          PolicyType: 'SSLNegotiationPolicyType',
          PolicyName: 'ELBSecurityPolicy-2015-05',
          Attributes: [{ Name: 'Protocol-SSLv3', Value: 'true' }],
        },
      ]).undeclared
    ).toEqual(['Policies']);
    // an out-of-band ADDED policy alongside the default SURFACES (array is no longer just the default)
    expect(
      t([
        defaultPolicy,
        { PolicyType: 'AppCookieStickinessPolicyType', PolicyName: 'my-stickiness' },
      ]).undeclared
    ).toEqual(['Policies']);
  });

  it('#716: IAM AccessKey Status default Active folds; an out-of-band Inactive flip surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'Ak',
      resourceType: 'AWS::IAM::AccessKey',
      physicalId: 'AKIA...',
      declared: { UserName: 'svc' }, // Status omitted -> AWS default Active
    };
    // clean deploy: undeclared Status "Active" folds atDefault (no first-run FP from the new reader)
    expect(
      tiers(classifyResource(res, { UserName: 'svc', Status: 'Active' }, emptySchema)).atDefault
    ).toEqual(['Status']);
    // an out-of-band deactivation (Active -> Inactive) SURFACES — the drift #716 restores
    expect(
      tiers(classifyResource(res, { UserName: 'svc', Status: 'Inactive' }, emptySchema)).undeclared
    ).toEqual(['Status']);
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

  it('#554: ClientVPN + DAX first-run defaults fold; an out-of-band change surfaces', () => {
    const t = (rt: string, live: Record<string, unknown>) =>
      tiers(classifyResource(bare(rt), live, emptySchema));
    // ClientVpnEndpoint VpnPort 443 / DisconnectOnSessionTimeout true → fold; a flipped
    // port (1194) or disabled disconnect surfaces as real undeclared drift.
    expect(
      t('AWS::EC2::ClientVpnEndpoint', {
        VpnPort: 443,
        DisconnectOnSessionTimeout: true,
      }).atDefault.sort()
    ).toEqual(['DisconnectOnSessionTimeout', 'VpnPort']);
    expect(t('AWS::EC2::ClientVpnEndpoint', { VpnPort: 1194 }).undeclared).toEqual(['VpnPort']);
    // DAX ClusterEndpointEncryptionType NONE → fold; TLS (an explicit opt-in) surfaces.
    expect(t('AWS::DAX::Cluster', { ClusterEndpointEncryptionType: 'NONE' }).atDefault).toEqual([
      'ClusterEndpointEncryptionType',
    ]);
    expect(t('AWS::DAX::Cluster', { ClusterEndpointEncryptionType: 'TLS' }).undeclared).toEqual([
      'ClusterEndpointEncryptionType',
    ]);
  });

  it('LineLink first-run folds: GlobalTable WarmThroughput / ESM Enabled / Authorizer AuthType', () => {
    // Three undeclared values a fresh dev LineLink stack reported with NO out-of-band
    // edit — first-run noise that must fold to atDefault, while a meaningful change to
    // each still surfaces (equality-gated).
    const t = (rt: string, live: Record<string, unknown>) =>
      tiers(classifyResource(bare(rt), live, emptySchema));

    // PAY_PER_REQUEST TableV2 baseline warm throughput → folds; a warmed-up table surfaces.
    expect(
      t('AWS::DynamoDB::GlobalTable', {
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      }).atDefault
    ).toEqual(['WarmThroughput']);
    expect(
      t('AWS::DynamoDB::GlobalTable', {
        WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
      }).undeclared
    ).toEqual(['WarmThroughput']);

    // The classic AWS::DynamoDB::Table (L1) reads back the SAME baseline warm throughput
    // when on-demand — observed live on a dev reco-MailQueues stack — so it folds too;
    // a warmed-up table still surfaces (equality-gated).
    expect(
      t('AWS::DynamoDB::Table', {
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      }).atDefault
    ).toEqual(['WarmThroughput']);
    expect(
      t('AWS::DynamoDB::Table', {
        WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
      }).undeclared
    ).toEqual(['WarmThroughput']);

    // ESM created enabled → folds. (Enabled:false is dropped upstream as trivially-empty,
    // like the KMS Key Enabled case — neither undeclared nor atDefault.) #632 fixed the
    // KMS/SQS twins of this via the curated MEANINGFUL_WHEN_OFF allowlist; ESM is left
    // unchanged here pending a live confirm that an undeclared ESM Enabled=false is
    // unconditionally a real out-of-band disable.
    expect(t('AWS::Lambda::EventSourceMapping', { Enabled: true }).atDefault).toEqual(['Enabled']);
    const disabled = t('AWS::Lambda::EventSourceMapping', { Enabled: false });
    expect(disabled.undeclared).toEqual([]);
    expect(disabled.atDefault).toEqual([]);

    // AuthType is a derived, non-declarable read-back of the declared Type, so BOTH the
    // Cognito ("cognito_user_pools") and TOKEN/REQUEST ("custom", observed live on a
    // my-app AimAssociation TOKEN authorizer) forms fold value-independently.
    expect(t('AWS::ApiGateway::Authorizer', { AuthType: 'cognito_user_pools' }).atDefault).toEqual([
      'AuthType',
    ]);
    expect(t('AWS::ApiGateway::Authorizer', { AuthType: 'custom' }).atDefault).toEqual([
      'AuthType',
    ]);
    expect(t('AWS::ApiGateway::Authorizer', { AuthType: 'custom' }).undeclared).toEqual([]);
  });

  it('my-app-Exporter first-run folds: Glue::Job derived capacity / SG rule peer-name echo', () => {
    // Undeclared values a fresh my-app-Exporter stack reported with NO out-of-band edit.
    const t = (rt: string, live: Record<string, unknown>) =>
      tiers(classifyResource(bare(rt), live, emptySchema));

    // A glueetl job sized with WorkerType/NumberOfWorkers declares neither capacity field;
    // AWS derives both and reads them back (G.1X × 10 → 10, G.025X × 2 → 0.5). Value-
    // independent, so every DPU value folds; a job that DECLARES MaxCapacity still surfaces.
    expect(t('AWS::Glue::Job', { MaxCapacity: 10, AllocatedCapacity: 10 }).atDefault).toEqual([
      'AllocatedCapacity',
      'MaxCapacity',
    ]);
    expect(t('AWS::Glue::Job', { MaxCapacity: 0.5, AllocatedCapacity: 0 }).atDefault).toEqual([
      'AllocatedCapacity',
      'MaxCapacity',
    ]);
    expect(t('AWS::Glue::Job', { MaxCapacity: 10 }).undeclared).toEqual([]);

    // A rule referencing its peer by id reads back the peer group's NAME — an AWS reflection of
    // the declared id, never user intent when undeclared. Ingress echoes SourceSecurityGroupName,
    // egress echoes DestinationSecurityGroupName (its declared id is DestinationSecurityGroupId) —
    // #888 fixed the egress key, which had wrongly been SourceSecurityGroupName.
    expect(
      t('AWS::EC2::SecurityGroupIngress', { SourceSecurityGroupName: 'my-app-Exporter-Glue-sg' })
        .atDefault
    ).toEqual(['SourceSecurityGroupName']);
    expect(
      t('AWS::EC2::SecurityGroupEgress', { DestinationSecurityGroupName: 'some-other-sg' })
        .atDefault
    ).toEqual(['DestinationSecurityGroupName']);
    expect(
      t('AWS::EC2::SecurityGroupIngress', { SourceSecurityGroupName: 'x' }).undeclared
    ).toEqual([]);
  });

  it('hunt-lowcov first-run folds: S3Express DirectoryBucket / S3Tables TableBucket / Logs Delivery family', () => {
    // Constant service defaults observed live on fresh s3express-s3tables-rich and
    // cloudfront-kvs-logs-delivery deploys with NO out-of-band edit — first-run noise
    // that must fold to atDefault, while a real change to each surfaces (equality-gated).
    const t = (rt: string, live: Record<string, unknown>) =>
      tiers(classifyResource(bare(rt), live, emptySchema));

    // Directory buckets are always encrypted: SSE-S3 with the bucket key ON.
    const dirEnc = (algo: string) => ({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: algo } },
        ],
      },
    });
    expect(t('AWS::S3Express::DirectoryBucket', dirEnc('AES256')).atDefault).toEqual([
      'BucketEncryption',
    ]);
    expect(t('AWS::S3Express::DirectoryBucket', dirEnc('aws:kms')).undeclared).toEqual([
      'BucketEncryption',
    ]);

    // Table buckets materialize three constant defaults; a KMS switch surfaces.
    expect(
      t('AWS::S3Tables::TableBucket', {
        StorageClassConfiguration: { StorageClass: 'STANDARD' },
        MetricsConfiguration: { Status: 'Disabled' },
        EncryptionConfiguration: { SSEAlgorithm: 'AES256' },
      }).atDefault.sort()
    ).toEqual(['EncryptionConfiguration', 'MetricsConfiguration', 'StorageClassConfiguration']);
    expect(
      t('AWS::S3Tables::TableBucket', { EncryptionConfiguration: { SSEAlgorithm: 'aws:kms' } })
        .undeclared
    ).toEqual(['EncryptionConfiguration']);

    // Vended logs v2: a log-group destination derives DeliveryDestinationType "CWL";
    // an S3 destination's value doesn't match the fold and surfaces (recordable).
    expect(
      t('AWS::Logs::DeliveryDestination', { DeliveryDestinationType: 'CWL' }).atDefault
    ).toEqual(['DeliveryDestinationType']);
    expect(
      t('AWS::Logs::DeliveryDestination', { DeliveryDestinationType: 'S3' }).undeclared
    ).toEqual(['DeliveryDestinationType']);

    // A Delivery with no declared RecordFields reads back the source's FULL default
    // field list (CloudFront ACCESS_LOGS here); a trimmed selection surfaces.
    const cfFields = KNOWN_DEFAULTS['AWS::Logs::Delivery'].RecordFields as string[];
    expect(cfFields.length).toBeGreaterThan(30);
    expect(t('AWS::Logs::Delivery', { RecordFields: cfFields }).atDefault).toEqual([
      'RecordFields',
    ]);
    expect(t('AWS::Logs::Delivery', { RecordFields: cfFields.slice(0, 5) }).undeclared).toEqual([
      'RecordFields',
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
      // (SomeOrderedProp is not in the UserPoolClient set; ReadAttributes/WriteAttributes
      // are now folded — see the dedicated #875 test below).
      expect(
        tiers(
          classifyResource(
            client({ SomeOrderedProp: ['a', 'b'] }),
            { SomeOrderedProp: ['b', 'a'] },
            emptySchema
          )
        ).declared
      ).toEqual(['SomeOrderedProp']);
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

    // #875: Cognito ALPHABETICALLY SORTS the attribute lists it echoes back — declared
    // ReadAttributes ["phone_number","email","name"] reads back sorted ["email","name",
    // "phone_number"], a permanent declared FP that survives record and churns on revert.
    // Set-semantic, same class as the OAuth/URL siblings. SupportedIdentityProviders too.
    it('UNORDERED_ARRAY_PROPS: Cognito ReadAttributes/WriteAttributes/SupportedIdentityProviders sort is NOT drift (#875)', () => {
      const client = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'Client',
        resourceType: 'AWS::Cognito::UserPoolClient',
        physicalId: 'client123',
        declared,
      });
      for (const prop of ['ReadAttributes', 'WriteAttributes', 'SupportedIdentityProviders']) {
        // declared in natural order, read back service-sorted -> no drift
        expect(
          classifyResource(
            client({ [prop]: ['phone_number', 'email', 'name', 'family_name', 'birthdate'] }),
            { [prop]: ['birthdate', 'email', 'family_name', 'name', 'phone_number'] },
            emptySchema
          )
        ).toEqual([]);
        // a genuine attribute add/remove still changes the multiset -> reports
        expect(
          tiers(
            classifyResource(
              client({ [prop]: ['phone_number', 'email', 'name'] }),
              { [prop]: ['email', 'name', 'address'] },
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

    // Live-observed FP (codedeploy-deploymentgroup-readgap fixture): a deployment
    // group's AutoRollbackConfiguration.Events is a SET of rollback-trigger enums that
    // CodeDeploy echoes SORTED alphabetically. The path is NESTED, so this also pins
    // that the declared-loop fold keys on the full dotted `d.path`.
    it('UNORDERED_ARRAY_PROPS: CodeDeploy DeploymentGroup nested AutoRollbackConfiguration.Events reorder is NOT drift', () => {
      const dg = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'Group',
        resourceType: 'AWS::CodeDeploy::DeploymentGroup',
        physicalId: 'cdkrd-readgap-dg',
        declared,
      });
      // same event set, reordered (AWS sorts) -> no drift
      expect(
        classifyResource(
          dg({
            AutoRollbackConfiguration: {
              Enabled: true,
              Events: ['DEPLOYMENT_STOP_ON_ALARM', 'DEPLOYMENT_FAILURE'],
            },
          }),
          {
            AutoRollbackConfiguration: {
              Enabled: true,
              Events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM'],
            },
          },
          emptySchema
        )
      ).toEqual([]);
      // a genuine event change still reports the nested path
      expect(
        tiers(
          classifyResource(
            dg({
              AutoRollbackConfiguration: {
                Enabled: true,
                Events: ['DEPLOYMENT_STOP_ON_ALARM', 'DEPLOYMENT_FAILURE'],
              },
            }),
            {
              AutoRollbackConfiguration: {
                Enabled: true,
                Events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_REQUEST'],
              },
            },
            emptySchema
          )
        ).declared
      ).toEqual(['AutoRollbackConfiguration.Events']);
    });

    // Live-observed FP (codepipeline-triggers fixture): a V2 pipeline's Git trigger
    // filter lists (Branches/FilePaths Includes/Excludes) are `uniqueItems: true` sets the
    // CFn schema does NOT mark insertionOrder:false, so they need a per-type UNORDERED entry.
    // The path is under TWO array indices (Triggers[] and Push[]), so this also pins the
    // numeric-index -> `*` wildcard normalization in the classify lookup.
    it('UNORDERED_ARRAY_PROPS: CodePipeline trigger Branches.Includes reorder (nested under array indices) is NOT drift', () => {
      const pipe = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'Pipeline',
        resourceType: 'AWS::CodePipeline::Pipeline',
        physicalId: 'cdkrd-triggers-pipeline',
        declared,
      });
      const withBranches = (includes: string[]): Record<string, unknown> => ({
        Triggers: [
          {
            GitConfiguration: {
              SourceActionName: 'GitHubSource',
              Push: [{ Branches: { Includes: includes, Excludes: ['hotfix/*'] } }],
            },
          },
        ],
      });
      // same branch-glob set, reordered (CodePipeline stores it as a set) -> no drift
      expect(
        classifyResource(
          pipe(withBranches(['release/*', 'main', 'develop'])),
          withBranches(['develop', 'release/*', 'main']),
          emptySchema
        )
      ).toEqual([]);
      // a genuine glob add/remove still changes the multiset -> reports the nested path
      expect(
        tiers(
          classifyResource(
            pipe(withBranches(['release/*', 'main', 'develop'])),
            withBranches(['release/*', 'main']),
            emptySchema
          )
        ).declared
      ).toEqual(['Triggers.0.GitConfiguration.Push.0.Branches.Includes']);
    });

    // Live-observed (rds-sgset / redshift-probe fixtures): AWS returns a declared
    // VPC-security-group ID SET in a DIFFERENT order than the template (RDS DBInstance
    // declared [sg-0ffb…, sg-0fc3…, sg-02a7…] read back [sg-02a7…, sg-0ffb…, sg-0fc3…]).
    // Unlike the CodePipeline glob sets above, the elements ARE resource ids, so the
    // GENERIC content-based `isIdLike` canonicalizer folds them with NO per-type table —
    // this pins that end-to-end for the whole SG/subnet/ARN-id-set class. A genuine SG
    // add/remove still changes the multiset and reports.
    it('id-array fold: RDS DBInstance VPCSecurityGroups reorder (real sg-ids) is NOT drift', () => {
      const db = (sgs: string[]): DesiredResource => ({
        logicalId: 'Db',
        resourceType: 'AWS::RDS::DBInstance',
        physicalId: 'cdkrd-rds-sgset',
        declared: { VPCSecurityGroups: sgs },
      });
      // same SG set, AWS canonical order -> no drift (isIdLike sorts both sides)
      expect(
        classifyResource(
          db(['sg-0ffb59706a86e4368', 'sg-0fc374f7174e89e17', 'sg-02a70a5865b6b0826']),
          {
            VPCSecurityGroups: [
              'sg-02a70a5865b6b0826',
              'sg-0ffb59706a86e4368',
              'sg-0fc374f7174e89e17',
            ],
          },
          emptySchema
        )
      ).toEqual([]);
      // a genuine SG removal still changes the multiset -> reports
      expect(
        tiers(
          classifyResource(
            db(['sg-0ffb59706a86e4368', 'sg-0fc374f7174e89e17', 'sg-02a70a5865b6b0826']),
            { VPCSecurityGroups: ['sg-02a70a5865b6b0826', 'sg-0ffb59706a86e4368'] },
            emptySchema
          )
        ).declared
      ).toEqual(['VPCSecurityGroups']);
    });

    // Schema-driven fold (insertionOrder:false): ECS marks RequiresCompatibilities
    // insertionOrder:false, so the launch-type set AWS sorts alphabetically (declared
    // [FARGATE, EC2] read back [EC2, FARGATE]) folds from the schema — no per-type entry.
    it('unorderedScalarPaths: ECS TaskDefinition RequiresCompatibilities (schema insertionOrder:false) reorder is NOT drift', () => {
      const schema: SchemaInfo = {
        ...emptySchema,
        unorderedScalarPaths: ['RequiresCompatibilities'],
      };
      const td = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'TaskDef',
        resourceType: 'AWS::ECS::TaskDefinition',
        physicalId: 'cdkrd-enumset:1',
        declared,
      });
      expect(
        classifyResource(
          td({ RequiresCompatibilities: ['FARGATE', 'EC2'] }),
          { RequiresCompatibilities: ['EC2', 'FARGATE'] },
          schema
        )
      ).toEqual([]);
      // a genuine launch-type change still reports
      expect(
        tiers(
          classifyResource(
            td({ RequiresCompatibilities: ['FARGATE', 'EC2'] }),
            { RequiresCompatibilities: ['EC2', 'EXTERNAL'] },
            schema
          )
        ).declared
      ).toEqual(['RequiresCompatibilities']);
      // WITHOUT the schema path (empty schema), the same reorder DOES report — proving
      // the suppression is driven by the schema flag, not a manual table.
      expect(
        tiers(
          classifyResource(
            td({ RequiresCompatibilities: ['FARGATE', 'EC2'] }),
            { RequiresCompatibilities: ['EC2', 'FARGATE'] },
            emptySchema
          )
        ).declared
      ).toEqual(['RequiresCompatibilities']);
    });

    // Schema-driven OBJECT-array fold (#459): the schema marks ArchiveRules
    // insertionOrder:false and its items carry no identity field, so AWS echoing the
    // set sorted by RuleName folds FROM THE SCHEMA — no UNORDERED_OBJECT_ARRAY_PROPS
    // entry for this (fake) type. Mirrors the live AccessAnalyzer ArchiveRules FP.
    it('unorderedObjectArrayPaths: a schema-unordered OBJECT array reorder is NOT drift (no per-type entry)', () => {
      const schema: SchemaInfo = {
        ...emptySchema,
        unorderedObjectArrayPaths: ['ArchiveRules'],
      };
      const rules = [
        { RuleName: 'zeta', Filter: [{ Property: 'isPublic', Eq: ['false'] }] },
        { RuleName: 'alpha', Filter: [{ Property: 'resourceType', Eq: ['AWS::S3::Bucket'] }] },
      ];
      const an = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'Analyzer',
        resourceType: 'AWS::Fake::Analyzer', // NOT in any manual table
        physicalId: 'an-1',
        declared,
      });
      // AWS echoes the set sorted by RuleName -> folds via the schema flag
      expect(
        classifyResource(
          an({ ArchiveRules: rules }),
          { ArchiveRules: [rules[1], rules[0]] },
          schema
        )
      ).toEqual([]);
      // a genuine element change still reports
      expect(
        tiers(
          classifyResource(
            an({ ArchiveRules: rules }),
            {
              ArchiveRules: [
                {
                  RuleName: 'alpha',
                  Filter: [{ Property: 'resourceType', Eq: ['AWS::SQS::Queue'] }],
                },
                rules[0],
              ],
            },
            schema
          )
        ).declared.length
      ).toBeGreaterThan(0);
      // WITHOUT the schema path (empty schema), the same reorder DOES report — proving
      // the suppression is driven by the schema flag, not a manual table.
      expect(
        tiers(
          classifyResource(
            an({ ArchiveRules: rules }),
            { ArchiveRules: [rules[1], rules[0]] },
            emptySchema
          )
        ).declared.length
      ).toBeGreaterThan(0);
    });

    // Schema-driven OBJECT-array fold, NESTED dotted path: the unordered set lives
    // under a structured object (Config.Rules) — folded via the nestedSubPaths
    // mechanics UNORDERED_NESTED_OBJECT_ARRAY_PATHS uses, but schema-driven.
    it('unorderedObjectArrayPaths: a schema-unordered NESTED object array reorder is NOT drift', () => {
      const schema: SchemaInfo = {
        ...emptySchema,
        unorderedObjectArrayPaths: ['Config.Rules'],
      };
      const rules = [
        { Pattern: 'zzz', Action: 'BLOCK' },
        { Pattern: 'aaa', Action: 'ALLOW' },
      ];
      const res = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'R',
        resourceType: 'AWS::Fake::RuleThing',
        physicalId: 'r-1',
        declared,
      });
      expect(
        classifyResource(
          res({ Config: { Rules: rules } }),
          { Config: { Rules: [rules[1], rules[0]] } },
          schema
        )
      ).toEqual([]);
      // a genuine nested change still reports
      expect(
        tiers(
          classifyResource(
            res({ Config: { Rules: rules } }),
            { Config: { Rules: [{ Pattern: 'aaa', Action: 'COUNT' }, rules[0]] } },
            schema
          )
        ).declared.length
      ).toBeGreaterThan(0);
    });

    // Schema-driven fold (nested): Route53 marks HealthCheckConfig.Regions
    // insertionOrder:false; AWS sorts the region set alphabetically (declared
    // [us-west-2, us-east-1, eu-west-1] read back [eu-west-1, us-east-1, us-west-2]).
    it('unorderedScalarPaths: Route53 HealthCheck nested HealthCheckConfig.Regions (schema insertionOrder:false) reorder is NOT drift', () => {
      const schema: SchemaInfo = {
        ...emptySchema,
        unorderedScalarPaths: ['HealthCheckConfig.Regions'],
      };
      const hc = (declared: Record<string, unknown>): DesiredResource => ({
        logicalId: 'HealthCheck',
        resourceType: 'AWS::Route53::HealthCheck',
        physicalId: 'hc-1',
        declared,
      });
      expect(
        classifyResource(
          hc({
            HealthCheckConfig: { Type: 'HTTP', Regions: ['us-west-2', 'us-east-1', 'eu-west-1'] },
          }),
          { HealthCheckConfig: { Type: 'HTTP', Regions: ['eu-west-1', 'us-east-1', 'us-west-2'] } },
          schema
        )
      ).toEqual([]);
      // a genuine region change still reports the nested path
      expect(
        tiers(
          classifyResource(
            hc({
              HealthCheckConfig: { Type: 'HTTP', Regions: ['us-west-2', 'us-east-1', 'eu-west-1'] },
            }),
            {
              HealthCheckConfig: {
                Type: 'HTTP',
                Regions: ['eu-west-1', 'us-east-1', 'ap-southeast-1'],
              },
            },
            schema
          )
        ).declared
      ).toEqual(['HealthCheckConfig.Regions']);
    });

    // Live-observed FP (rds-logexports-reorder fixture): RDS echoes a DB instance's
    // EnableCloudwatchLogsExports log-type set SORTED alphabetically (declared
    // [slowquery, general, error] read back [error, general, slowquery]). The same
    // property is a log-type SET on the whole RDS family, so it is folded for all four
    // (DBInstance live-proven; the rest are class closure, equality-gated).
    it('UNORDERED_ARRAY_PROPS: RDS-family EnableCloudwatchLogsExports reorder is NOT drift', () => {
      for (const resourceType of [
        'AWS::RDS::DBInstance',
        'AWS::RDS::DBCluster',
        'AWS::Neptune::DBCluster',
        'AWS::DocDB::DBCluster',
      ]) {
        const db = (declared: Record<string, unknown>): DesiredResource => ({
          logicalId: 'Db',
          resourceType,
          physicalId: 'db-1',
          declared,
        });
        // same log-type set, reordered (AWS sorts) -> no drift
        expect(
          classifyResource(
            db({ EnableCloudwatchLogsExports: ['slowquery', 'general', 'error'] }),
            { EnableCloudwatchLogsExports: ['error', 'general', 'slowquery'] },
            emptySchema
          )
        ).toEqual([]);
        // a genuine log-type change still reports
        expect(
          tiers(
            classifyResource(
              db({ EnableCloudwatchLogsExports: ['slowquery', 'general', 'error'] }),
              { EnableCloudwatchLogsExports: ['error', 'general', 'audit'] },
              emptySchema
            )
          ).declared
        ).toEqual(['EnableCloudwatchLogsExports']);
      }
    });

    // Live-observed (same fixture): CodeDeploy always echoes OutdatedInstancesStrategy
    // = "UPDATE" on a group that never declared it (documented unspecified behavior).
    it('KNOWN_DEFAULTS: undeclared CodeDeploy OutdatedInstancesStrategy=UPDATE folds to atDefault; IGNORE surfaces', () => {
      const res = (live: Record<string, unknown>) =>
        classifyResource(
          {
            logicalId: 'Group',
            resourceType: 'AWS::CodeDeploy::DeploymentGroup',
            physicalId: 'cdkrd-readgap-dg',
            declared: {},
          },
          live,
          emptySchema
        );
      expect(tiers(res({ OutdatedInstancesStrategy: 'UPDATE' })).atDefault).toEqual([
        'OutdatedInstancesStrategy',
      ]);
      // an out-of-band switch to IGNORE is no longer the default -> surfaces as undeclared
      expect(tiers(res({ OutdatedInstancesStrategy: 'IGNORE' })).undeclared).toEqual([
        'OutdatedInstancesStrategy',
      ]);
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
    // AWS returns ~15 attributes; the template declared 2. The live-only keys here are
    // all at their AWS default EXCEPT waf.fail_open.enabled (default "false") set to
    // "true" — an out-of-band / non-default value that must stay undeclared (fail-closed).
    const liveAll = [
      { Key: 'access_logs.s3.enabled', Value: 'false' },
      { Key: 'idle_timeout.timeout_seconds', Value: '120' },
      { Key: 'routing.http2.enabled', Value: 'true' },
      { Key: 'deletion_protection.enabled', Value: 'false' },
      { Key: 'client_keep_alive.seconds', Value: '3600' },
      { Key: 'waf.fail_open.enabled', Value: 'true' },
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

    it('live-only bag keys AT their AWS default fold to atDefault (first-run noise)', () => {
      // The ~15-20 server-default attributes AWS always echoes are first-run noise: a
      // live-only key whose value equals its curated ELB_ATTRIBUTE_DEFAULTS entry is
      // surfaced in the atDefault tier (informational, never drift), shrinking the
      // [Potential Drift] inventory. Equality-gated + per-key, so it can never hide a change.
      const atDefault = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: liveAll },
        emptySchema
      ).filter((f) => f.tier === 'atDefault');
      expect(atDefault.map((f) => f.path).sort()).toEqual([
        'LoadBalancerAttributes[access_logs.s3.enabled]',
        'LoadBalancerAttributes[client_keep_alive.seconds]',
        'LoadBalancerAttributes[routing.http2.enabled]',
      ]);
      expect(atDefault.every((f) => f.nested === true)).toBe(true);
    });

    it('fail-closed: a live-only bag key NOT at its default stays undeclared inventory', () => {
      // waf.fail_open.enabled default is "false"; live "true" is NOT the default, so it
      // must NOT fold to atDefault — it stays undeclared (recorded, a later change vs the
      // baseline then surfaces as drift). This is the equality gate that keeps the
      // per-key default fold from ever hiding a real out-of-band value.
      const undeclared = classifyResource(
        res(T, declared),
        { LoadBalancerAttributes: liveAll },
        emptySchema
      ).filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path)).toEqual([
        'LoadBalancerAttributes[waf.fail_open.enabled]',
      ]);
      expect(undeclared[0]).toMatchObject({ actual: 'true', nested: true });
    });

    it('a bare ALB idle_timeout default (60) and NLB-only keys fold to atDefault', () => {
      // A bare ALB declares no idleTimeout -> idle_timeout.timeout_seconds reads back the
      // live default "60"; a fresh NLB returns dns_record.client_routing_policy and
      // secondary_ips.auto_assigned.per_subnet. All are curated defaults -> atDefault.
      const atDefault = classifyResource(
        res(T, {
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
        }),
        {
          LoadBalancerAttributes: [
            { Key: 'deletion_protection.enabled', Value: 'false' },
            { Key: 'idle_timeout.timeout_seconds', Value: '60' },
            { Key: 'dns_record.client_routing_policy', Value: 'any_availability_zone' },
            { Key: 'secondary_ips.auto_assigned.per_subnet', Value: '0' },
          ],
        },
        emptySchema
      ).filter((f) => f.tier === 'atDefault');
      expect(atDefault.map((f) => f.path).sort()).toEqual([
        'LoadBalancerAttributes[dns_record.client_routing_policy]',
        'LoadBalancerAttributes[idle_timeout.timeout_seconds]',
        'LoadBalancerAttributes[secondary_ips.auto_assigned.per_subnet]',
      ]);
    });

    it("an NLB's cross_zone default (false) folds to atDefault via the per-LB-type override", () => {
      // ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE keys on the live Type: an NLB's cross_zone
      // default is "false" (the OPPOSITE of the shared ALB entry), so a fresh NLB is no
      // longer first-run noise (observed live on iot-vpces-rich).
      const nlbLive = (crossZone: string) => ({
        Type: 'network',
        LoadBalancerAttributes: [
          { Key: 'deletion_protection.enabled', Value: 'false' },
          { Key: 'load_balancing.cross_zone.enabled', Value: crossZone },
        ],
      });
      const nlbDeclared = {
        Type: 'network',
        LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
      };
      const atDefault = classifyResource(res(T, nlbDeclared), nlbLive('false'), emptySchema).filter(
        (f) => f.tier === 'atDefault'
      );
      expect(atDefault.map((f) => f.path)).toEqual([
        'LoadBalancerAttributes[load_balancing.cross_zone.enabled]',
      ]);
    });

    it("an NLB's out-of-band cross_zone ENABLE (true) stays undeclared — the shared ALB default must NOT mis-fold it", () => {
      // Before the per-type override, "true" matched the shared ALB entry -> atDefault,
      // so `record` never snapshotted a REAL undeclared change (an FN, not just noise).
      const undeclared = classifyResource(
        res(T, {
          Type: 'network',
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
        }),
        {
          Type: 'network',
          LoadBalancerAttributes: [
            { Key: 'deletion_protection.enabled', Value: 'false' },
            { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
          ],
        },
        emptySchema
      ).filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path)).toEqual([
        'LoadBalancerAttributes[load_balancing.cross_zone.enabled]',
      ]);
    });

    it("an ALB (no Type declared or read = application) keeps the shared cross_zone default: 'true' folds, 'false' surfaces", () => {
      const albLive = (crossZone: string) => ({
        LoadBalancerAttributes: [
          { Key: 'deletion_protection.enabled', Value: 'false' },
          { Key: 'load_balancing.cross_zone.enabled', Value: crossZone },
        ],
      });
      const albDeclared = {
        LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
      };
      const path = 'LoadBalancerAttributes[load_balancing.cross_zone.enabled]';
      expect(
        classifyResource(res(T, albDeclared), albLive('true'), emptySchema).find(
          (f) => f.path === path
        )?.tier
      ).toBe('atDefault');
      expect(
        classifyResource(res(T, albDeclared), albLive('false'), emptySchema).find(
          (f) => f.path === path
        )?.tier
      ).toBe('undeclared');
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

  describe('Firehose processor Parameters subset (ParameterName-keyed reorder + server default-fill)', () => {
    const T = 'AWS::KinesisFirehose::DeliveryStream';
    const declared = {
      ExtendedS3DestinationConfiguration: {
        ProcessingConfiguration: {
          Enabled: true,
          Processors: [
            {
              Type: 'Lambda',
              Parameters: [
                { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
                { ParameterName: 'BufferSizeInMBs', ParameterValue: '1' },
                {
                  ParameterName: 'LambdaArn',
                  ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f',
                },
              ],
            },
          ],
        },
      },
    };
    const liveProcessing = (params: unknown[]) => ({
      ExtendedS3DestinationConfiguration: {
        ProcessingConfiguration: {
          Enabled: true,
          Processors: [{ Type: 'Lambda', Parameters: params }],
        },
      },
    });

    it('a reordered set + server-injected param is NOT declared drift; the default NumberOfRetries folds to atDefault (#845)', () => {
      // AWS reorders the set (LambdaArn first) and injects NumberOfRetries=3 — exactly the
      // shape observed live on firehose-processors-rich. Declared subset of live by
      // ParameterName -> no declared FP. The server-injected NumberOfRetries="3" is the AWS
      // default (#845), so the live-only entry folds to atDefault (not undeclared); a clean
      // stream stays clean while a non-"3" retry count still surfaces (see below).
      const findings = classifyResource(
        res(T, declared),
        liveProcessing([
          { ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f' },
          { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
          { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
          { ParameterName: 'BufferSizeInMBs', ParameterValue: '1' },
        ]),
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
      expect(findings.filter((f) => f.tier === 'undeclared')).toEqual([]);
      const atDefault = findings.filter((f) => f.tier === 'atDefault');
      expect(atDefault.map((f) => f.path)).toEqual([
        'ExtendedS3DestinationConfiguration.ProcessingConfiguration.Processors.0.Parameters[NumberOfRetries]',
      ]);
      expect(atDefault[0]).toMatchObject({
        nested: true,
        actual: { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
      });
    });

    it('a NON-default NumberOfRetries still surfaces as undeclared (#845 detection preserved)', () => {
      // NumberOfRetries="5" diverges from the AWS default "3", so it is NOT folded — it
      // surfaces as undeclared inventory (recorded; a later change still surfaces).
      const undeclared = classifyResource(
        res(T, declared),
        liveProcessing([
          { ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f' },
          { ParameterName: 'NumberOfRetries', ParameterValue: '5' },
          { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
          { ParameterName: 'BufferSizeInMBs', ParameterValue: '1' },
        ]),
        emptySchema
      ).filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path)).toEqual([
        'ExtendedS3DestinationConfiguration.ProcessingConfiguration.Processors.0.Parameters[NumberOfRetries]',
      ]);
    });

    it('a genuine change to a DECLARED parameter value still surfaces as declared drift (fail-closed)', () => {
      // BufferSizeInMBs declared "1", live "5" -> alignNameValueSubset returns null
      // (a declared param value differs), so the whole-array finding is KEPT as drift.
      const declaredF = classifyResource(
        res(T, declared),
        liveProcessing([
          { ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f' },
          { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
          { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
          { ParameterName: 'BufferSizeInMBs', ParameterValue: '5' },
        ]),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]?.path).toBe(
        'ExtendedS3DestinationConfiguration.ProcessingConfiguration.Processors.0.Parameters'
      );
    });

    it('a declared parameter MISSING from live is declared drift, not silently dropped', () => {
      // live omits BufferSizeInMBs entirely -> declared NOT a subset of live -> kept.
      const declaredF = classifyResource(
        res(T, declared),
        liveProcessing([
          { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
          { ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f' },
        ]),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
    });

    it('the fold is destination-agnostic: a Redshift (non-ExtendedS3) Processors path also folds', () => {
      // NAME_VALUE_SUBSET_PATHS matches the dotted-path SUFFIX `Processors.<n>.Parameters`,
      // so the same reorder + default-fill on any destination config that carries a
      // ProcessingConfiguration (RedshiftDestinationConfiguration, AmazonopensearchserviceDestinationConfiguration,
      // SplunkDestinationConfiguration, …) is suppressed too — not just ExtendedS3.
      const redshiftDeclared = {
        RedshiftDestinationConfiguration: {
          ProcessingConfiguration: {
            Enabled: true,
            Processors: [
              {
                Type: 'Lambda',
                Parameters: [
                  {
                    ParameterName: 'LambdaArn',
                    ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f',
                  },
                  { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
                ],
              },
            ],
          },
        },
      };
      const findings = classifyResource(
        res(T, redshiftDeclared),
        {
          RedshiftDestinationConfiguration: {
            ProcessingConfiguration: {
              Enabled: true,
              Processors: [
                {
                  Type: 'Lambda',
                  Parameters: [
                    { ParameterName: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/r' },
                    { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
                    {
                      ParameterName: 'LambdaArn',
                      ParameterValue: 'arn:aws:lambda:us-east-1:1:function:f',
                    },
                  ],
                },
              ],
            },
          },
        },
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
      // #845: the server-injected NumberOfRetries="3" is the AWS default, so on any destination
      // config it folds to atDefault (not undeclared) — the fold is destination-agnostic too.
      expect(findings.filter((f) => f.tier === 'undeclared')).toEqual([]);
      expect(findings.filter((f) => f.tier === 'atDefault').map((f) => f.path)).toEqual([
        'RedshiftDestinationConfiguration.ProcessingConfiguration.Processors.0.Parameters[NumberOfRetries]',
      ]);
    });
  });

  describe('Firehose plain-S3 destination echoed as ExtendedS3 twin (#652 shape-mismatch echo)', () => {
    const T = 'AWS::KinesisFirehose::DeliveryStream';
    // S3DestinationConfiguration is writeOnly (readGap on read), so the live model surfaces
    // the destination only as the richer ExtendedS3DestinationConfiguration twin.
    const firehoseSchema: SchemaInfo = {
      readOnly: new Set(['Arn']),
      writeOnly: new Set(['S3DestinationConfiguration']),
      createOnly: new Set(['DeliveryStreamType', 'DeliveryStreamName']),
      readOnlyPaths: ['Arn'],
      writeOnlyPaths: ['S3DestinationConfiguration'],
      createOnlyPaths: ['DeliveryStreamType', 'DeliveryStreamName'],
      defaults: {},
      defaultPaths: {},
    };
    // Exactly the fresh-deploy model from tests/corpus/…DeliveryStream.Tap.json (#652):
    // declared plain S3DestinationConfiguration; live echoes it as ExtendedS3.
    const declared = {
      DeliveryStreamType: 'DirectPut',
      S3DestinationConfiguration: {
        BucketARN: 'arn:aws:s3:::mybucket',
        BufferingHints: { IntervalInSeconds: 300, SizeInMBs: 5 },
        CompressionFormat: 'GZIP',
        RoleARN: 'arn:aws:iam::111111111111:role/FirehoseRole',
      },
    };
    const liveTwin = (overrides: Record<string, unknown> = {}) => ({
      DeliveryStreamType: 'DirectPut',
      ExtendedS3DestinationConfiguration: {
        BucketARN: 'arn:aws:s3:::mybucket',
        BufferingHints: { IntervalInSeconds: 300, SizeInMBs: 5 },
        CompressionFormat: 'GZIP',
        EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
        CloudWatchLoggingOptions: { Enabled: false },
        RoleARN: 'arn:aws:iam::111111111111:role/FirehoseRole',
        S3BackupMode: 'Disabled',
        ...overrides,
      },
    });

    it('a clean deploy yields ZERO potential drift — the whole ExtendedS3 twin folds (no undeclared)', () => {
      const t = tiers(classifyResource(res(T, declared), liveTwin(), firehoseSchema));
      // The invariant: nothing surfaces as undeclared potential drift on a first check.
      expect(t.undeclared).toEqual([]);
      // The echoed overlap (BucketARN/BufferingHints/CompressionFormat/RoleARN) is matched and
      // dropped; the extended-only service defaults fold to atDefault (or drop as trivial-empty).
      expect(t.atDefault).toEqual([
        'ExtendedS3DestinationConfiguration.EncryptionConfiguration',
        'ExtendedS3DestinationConfiguration.S3BackupMode',
      ]);
      // The declared plain-S3 config is a readGap (writeOnly — cannot be read back).
      expect(t.readGap).toEqual(['S3DestinationConfiguration']);
    });

    it('a genuine out-of-band change in the twin still surfaces (detection preserved)', () => {
      // CompressionFormat flipped GZIP -> UNCOMPRESSED out of band: the overlap no longer
      // echoes, so the whole twin surfaces as undeclared drift (fail-open, detectable).
      const t = tiers(
        classifyResource(
          res(T, declared),
          liveTwin({ CompressionFormat: 'UNCOMPRESSED' }),
          firehoseSchema
        )
      );
      expect(t.undeclared).toEqual(['ExtendedS3DestinationConfiguration']);
    });

    it('an out-of-band ENABLED encryption in the extended-only block surfaces as nested drift', () => {
      // The overlap still echoes, but EncryptionConfiguration is no longer at its NoEncryption
      // default (a KMS key was attached out of band) — it surfaces, the rest still folds.
      const t = tiers(
        classifyResource(
          res(T, declared),
          liveTwin({
            EncryptionConfiguration: {
              KMSEncryptionConfig: { AWSKMSKeyARN: 'arn:aws:kms:us-east-1:111111111111:key/abc' },
            },
          }),
          firehoseSchema
        )
      );
      expect(t.undeclared).toEqual(['ExtendedS3DestinationConfiguration.EncryptionConfiguration']);
    });
  });

  describe('RDS OptionGroup OptionSettings subset (Name-keyed reorder + server default-fill, #480)', () => {
    const T = 'AWS::RDS::OptionGroup';
    const declared = {
      EngineName: 'mariadb',
      MajorEngineVersion: '10.11',
      OptionGroupDescription: 'audit option group',
      OptionConfigurations: [
        {
          OptionName: 'MARIADB_AUDIT_PLUGIN',
          OptionSettings: [
            { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT,QUERY' },
            { Name: 'SERVER_AUDIT_QUERY_LOG_LIMIT', Value: '2048' },
          ],
        },
      ],
    };
    // The live shape observed on a fresh rds-optiongroup-evsub deploy: RDS reorders the
    // settings and materializes EVERY option setting of the configured option — some
    // Name-only with no Value key at all.
    const liveConfigs = (settings: unknown[]) => ({
      EngineName: 'mariadb',
      MajorEngineVersion: '10.11',
      OptionGroupDescription: 'audit option group',
      OptionConfigurations: [
        {
          OptionName: 'MARIADB_AUDIT_PLUGIN',
          OptionSettings: settings,
        },
      ],
    });
    const liveDefaultFilled = [
      { Value: '2048', Name: 'SERVER_AUDIT_QUERY_LOG_LIMIT' },
      { Value: 'CONNECT,QUERY', Name: 'SERVER_AUDIT_EVENTS' },
      { Value: 'ON', Name: 'SERVER_AUDIT_LOGGING' },
      { Name: 'SERVER_AUDIT_INCL_USERS' },
      { Value: 'FORCE_PLUS_PERMANENT', Name: 'SERVER_AUDIT' },
      { Name: 'SERVER_AUDIT_FILE_ROTATIONS' },
      { Value: '/rdsdbdata/log/audit/', Name: 'SERVER_AUDIT_FILE_PATH' },
      { Name: 'SERVER_AUDIT_FILE_ROTATE_SIZE' },
      { Name: 'SERVER_AUDIT_EXCL_USERS' },
    ];

    it('a reordered + default-filled OptionSettings is NOT declared drift; live-only settings surface as undeclared', () => {
      const findings = classifyResource(
        res(T, declared),
        liveConfigs(liveDefaultFilled),
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
      const undeclared = findings.filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path).sort()).toEqual([
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_EXCL_USERS]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_FILE_PATH]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_FILE_ROTATE_SIZE]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_FILE_ROTATIONS]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_INCL_USERS]',
        'OptionConfigurations.0.OptionSettings[SERVER_AUDIT_LOGGING]',
      ]);
      expect(undeclared.every((f) => f.nested === true)).toBe(true);
    });

    it('a genuine change to a DECLARED setting value still surfaces as declared drift (fail-closed)', () => {
      const mutated = liveDefaultFilled.map((s) =>
        (s as { Name: string }).Name === 'SERVER_AUDIT_EVENTS'
          ? { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT' }
          : s
      );
      const declaredF = classifyResource(
        res(T, declared),
        liveConfigs(mutated),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]?.path).toBe('OptionConfigurations.0.OptionSettings');
    });

    it('a declared setting MISSING from live is declared drift, not silently dropped', () => {
      const withoutDeclared = liveDefaultFilled.filter(
        (s) => (s as { Name: string }).Name !== 'SERVER_AUDIT_QUERY_LOG_LIMIT'
      );
      const declaredF = classifyResource(
        res(T, declared),
        liveConfigs(withoutDeclared),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
    });

    it('an element carrying an unexpected extra key disqualifies the fold (kept as declared drift)', () => {
      // The subset compare only checks the Name/Value pair; an element with any other
      // sub-key would escape it, so alignNameValueSubset refuses the fold entirely and
      // the reordered + default-filled array stays a declared finding (fail-closed).
      const withExtraKey = liveDefaultFilled.map((s) =>
        (s as { Name: string }).Name === 'SERVER_AUDIT_EVENTS'
          ? { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT,QUERY', ApplyMethod: 'immediate' }
          : s
      );
      const declaredF = classifyResource(
        res(T, declared),
        liveConfigs(withExtraKey),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]?.path).toBe('OptionConfigurations.0.OptionSettings');
    });
  });

  describe('RedshiftServerless Workgroup ConfigParameters subset + writeOnly exemption (#490)', () => {
    const T = 'AWS::RedshiftServerless::Workgroup';
    // Declared one ConfigParameter; the CC read returns it plus the ~8-element default set.
    const declared = {
      ConfigParameters: [
        { ParameterKey: 'enable_case_sensitive_identifier', ParameterValue: 'true' },
      ],
    };
    const liveDefaultFilled = (declaredValue: string) => ({
      ConfigParameters: [
        { ParameterKey: 'datestyle', ParameterValue: 'ISO, MDY' },
        { ParameterKey: 'enable_user_activity_logging', ParameterValue: 'false' },
        { ParameterKey: 'query_group', ParameterValue: 'default' },
        { ParameterKey: 'require_ssl', ParameterValue: 'false' },
        { ParameterKey: 'search_path', ParameterValue: '$user, public' },
        { ParameterKey: 'auto_mv', ParameterValue: 'true' },
        { ParameterKey: 'enable_case_sensitive_identifier', ParameterValue: declaredValue },
      ],
    });

    it('a clean deploy folds the service default-fill: no declared drift (declared is a ParameterKey subset)', () => {
      const findings = classifyResource(res(T, declared), liveDefaultFilled('true'), emptySchema);
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    });

    it('an out-of-band flip of a DECLARED ConfigParameter surfaces as declared drift (#490 FN fixed)', () => {
      // enable_case_sensitive_identifier declared "true", live "false" -> subset align returns
      // null (a declared value differs), so the whole ConfigParameters array stays declared drift.
      const declaredF = classifyResource(
        res(T, declared),
        liveDefaultFilled('false'),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]?.path).toBe('ConfigParameters');
    });

    it('SecurityGroupIds / SubnetIds reorder is folded (id-like sets), a genuine swap still surfaces', () => {
      // Reorder only -> no drift (canonicalizeIdArraysDeep sorts id-like arrays both sides).
      expect(
        classifyResource(
          res(T, { SecurityGroupIds: ['sg-0a1b2c3d4e', 'sg-1122334455'] }),
          { SecurityGroupIds: ['sg-1122334455', 'sg-0a1b2c3d4e'] },
          emptySchema
        ).filter((f) => f.tier === 'declared')
      ).toEqual([]);
      // A real out-of-band SG swap still surfaces as declared drift (the security-relevant FN).
      expect(
        classifyResource(
          res(T, { SecurityGroupIds: ['sg-0a1b2c3d4e'] }),
          { SecurityGroupIds: ['sg-9988776655'] },
          emptySchema
        ).filter((f) => f.tier === 'declared')
      ).toHaveLength(1);
    });
  });

  describe('ElasticBeanstalk ConfigurationTemplate OptionSettings subset (composite Namespace+OptionName key + live-only ResourceName, #493)', () => {
    const T = 'AWS::ElasticBeanstalk::ConfigurationTemplate';
    // The template declares a handful of settings; each is keyed by Namespace+OptionName.
    const declared = {
      ApplicationName: 'cdkrd-hunt-ebapp',
      TemplateName: 'MyStack-EbTemplate-1CZ1zQUn5g9T',
      SolutionStackName: '64bit Amazon Linux 2 v3.5.0 running Docker',
      OptionSettings: [
        {
          Namespace: 'aws:autoscaling:asg',
          OptionName: 'MinSize',
          Value: '1',
        },
        {
          Namespace: 'aws:autoscaling:asg',
          OptionName: 'MaxSize',
          Value: '2',
        },
        {
          Namespace: 'aws:elasticbeanstalk:environment',
          OptionName: 'EnvironmentType',
          Value: 'LoadBalanced',
        },
      ],
    };
    // The live shape observed once the composite-identifier adapter makes the template
    // CC-readable: the service reorders the settings, materializes the fully resolved set
    // (here truncated for the test but representative of the ~58 live entries), AND injects
    // a `ResourceName` field on many entries that the template never declares.
    const liveModel = (settings: unknown[]) => ({
      ApplicationName: 'cdkrd-hunt-ebapp',
      TemplateName: 'MyStack-EbTemplate-1CZ1zQUn5g9T',
      SolutionStackName: '64bit Amazon Linux 2 v3.5.0 running Docker',
      // PlatformArn is a service-echoed top-level default the template never declares.
      PlatformArn:
        'arn:aws:elasticbeanstalk:us-east-1::platform/Docker running on 64bit Amazon Linux 2/3.5.0',
      OptionSettings: settings,
    });
    const liveDefaultFilled = [
      // declared entries, reordered + carrying a live-only ResourceName
      {
        ResourceName: 'AWSEBAutoScalingGroup',
        Value: 'LoadBalanced',
        Namespace: 'aws:elasticbeanstalk:environment',
        OptionName: 'EnvironmentType',
      },
      {
        ResourceName: 'AWSEBAutoScalingGroup',
        Value: '2',
        Namespace: 'aws:autoscaling:asg',
        OptionName: 'MaxSize',
      },
      {
        ResourceName: 'AWSEBAutoScalingGroup',
        Value: '1',
        Namespace: 'aws:autoscaling:asg',
        OptionName: 'MinSize',
      },
      // service-filled extras the template never declared
      {
        ResourceName: 'AWSEBAutoScalingGroup',
        Value: 'Any',
        Namespace: 'aws:autoscaling:asg',
        OptionName: 'Availability Zones',
      },
      {
        Value: '30',
        Namespace: 'aws:autoscaling:asg',
        OptionName: 'Cooldown',
      },
      {
        Value: 'tcp',
        Namespace: 'aws:elb:healthcheck',
        OptionName: 'HealthyThreshold',
      },
    ];

    it('a reordered + default-filled OptionSettings is NOT declared drift; each service-filled extra folds to its first-run default (atDefault) or surfaces if off-default', () => {
      const findings = classifyResource(
        res(T, declared),
        liveModel(liveDefaultFilled),
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
      // `Availability Zones` = "Any" is at its AWS default → folds to atDefault (invariant),
      // as does the top-level PlatformArn echo. `Cooldown` = "30" (default 360) and
      // `HealthyThreshold` = "tcp" (default 3) are OFF their defaults → still surface as
      // undeclared, so an out-of-band change to a service-filled option is not hidden.
      expect(
        findings
          .filter((f) => f.tier === 'atDefault')
          .map((f) => f.path)
          .sort()
      ).toEqual(['OptionSettings[aws:autoscaling:asg|Availability Zones]', 'PlatformArn']);
      const undeclared = findings.filter((f) => f.tier === 'undeclared');
      expect(undeclared.map((f) => f.path).sort()).toEqual([
        'OptionSettings[aws:autoscaling:asg|Cooldown]',
        'OptionSettings[aws:elb:healthcheck|HealthyThreshold]',
      ]);
      // the OptionSettings extras (folded or surfaced) are nested inventory
      expect(
        findings.filter((f) => f.path.startsWith('OptionSettings')).every((f) => f.nested === true)
      ).toBe(true);
    });

    it('a genuine change to a DECLARED setting value still surfaces as declared drift (fail-closed)', () => {
      const mutated = liveDefaultFilled.map((s) =>
        (s as { OptionName: string }).OptionName === 'MaxSize'
          ? { ...(s as object), Value: '9' }
          : s
      );
      const declaredF = classifyResource(res(T, declared), liveModel(mutated), emptySchema).filter(
        (f) => f.tier === 'declared'
      );
      expect(declaredF).toHaveLength(1);
      expect(declaredF[0]?.path).toBe('OptionSettings');
    });

    it('a declared setting MISSING from live is declared drift, not silently dropped', () => {
      const withoutDeclared = liveDefaultFilled.filter(
        (s) => (s as { OptionName: string }).OptionName !== 'MinSize'
      );
      const declaredF = classifyResource(
        res(T, declared),
        liveModel(withoutDeclared),
        emptySchema
      ).filter((f) => f.tier === 'declared');
      expect(declaredF).toHaveLength(1);
    });

    // OptionSettings fold tiers surfaced through classify (equality-gate + value-independent +
    // unknown). envType comes from the sibling EnvironmentType option (declared LoadBalanced).
    const opt = (namespace: string, optionName: string, value: string) => ({
      Namespace: namespace,
      OptionName: optionName,
      Value: value,
    });
    const tiersOf = (extra: object) =>
      tiers(
        classifyResource(res(T, declared), liveModel([...liveDefaultFilled, extra]), emptySchema)
      );

    it('an equality-gated constant folds at its default and surfaces when changed away', () => {
      const at = tiersOf(opt('aws:elasticbeanstalk:cloudwatch:logs', 'RetentionInDays', '7'));
      expect(at.atDefault).toContain(
        'OptionSettings[aws:elasticbeanstalk:cloudwatch:logs|RetentionInDays]'
      );
      const off = tiersOf(opt('aws:elasticbeanstalk:cloudwatch:logs', 'RetentionInDays', '30'));
      expect(off.undeclared).toContain(
        'OptionSettings[aws:elasticbeanstalk:cloudwatch:logs|RetentionInDays]'
      );
    });

    it('a value-independent option (the platform ImageId AMI) folds regardless of value', () => {
      const at = tiersOf(opt('aws:autoscaling:launchconfiguration', 'ImageId', 'ami-0deadbeef'));
      expect(at.atDefault).toContain('OptionSettings[aws:autoscaling:launchconfiguration|ImageId]');
    });

    it('an UNKNOWN option (not in any table) still surfaces as undeclared (fail-open to visibility)', () => {
      const t = tiersOf(opt('aws:elasticbeanstalk:customns', 'SomeNovelOption', 'x'));
      expect(t.undeclared).toContain(
        'OptionSettings[aws:elasticbeanstalk:customns|SomeNovelOption]'
      );
    });
  });

  describe('ebOptionSettingTier (EB OptionSettings first-run default classifier)', () => {
    it('equality-gated constant: at default → atDefault, changed away → undeclared', () => {
      const k = ['aws:elasticbeanstalk:cloudwatch:logs', 'RetentionInDays'] as const;
      expect(ebOptionSettingTier(k[0], k[1], '7', 'LoadBalanced')).toBe('atDefault');
      expect(ebOptionSettingTier(k[0], k[1], '30', 'LoadBalanced')).toBe('undeclared');
    });

    it('derived-from-EnvironmentType: MaxSize default is 1 (SingleInstance) / 4 (LoadBalanced)', () => {
      const k = ['aws:autoscaling:asg', 'MaxSize'] as const;
      expect(ebOptionSettingTier(k[0], k[1], '1', 'SingleInstance')).toBe('atDefault');
      expect(ebOptionSettingTier(k[0], k[1], '4', 'SingleInstance')).toBe('undeclared'); // 4 is the LB default, not SingleInstance's
      expect(ebOptionSettingTier(k[0], k[1], '4', 'LoadBalanced')).toBe('atDefault');
      expect(ebOptionSettingTier(k[0], k[1], '8', 'LoadBalanced')).toBe('undeclared');
    });

    it('value-independent: the platform AMI id folds at any value', () => {
      const k = ['aws:autoscaling:launchconfiguration', 'ImageId'] as const;
      expect(ebOptionSettingTier(k[0], k[1], 'ami-000', 'LoadBalanced')).toBe('atDefault');
      expect(ebOptionSettingTier(k[0], k[1], 'ami-fff', 'LoadBalanced')).toBe('atDefault');
    });

    it('an unknown option is undeclared (surfaces)', () => {
      expect(ebOptionSettingTier('aws:x', 'Novel', 'v', 'LoadBalanced')).toBe('undeclared');
    });

    it('an unset option (null or empty Value) folds — DescribeConfigurationSettings returns many', () => {
      expect(ebOptionSettingTier('aws:ec2:vpc', 'VPCId', null, 'LoadBalanced')).toBe('atDefault');
      expect(
        ebOptionSettingTier('aws:autoscaling:asg', 'Custom Availability Zones', '', 'LoadBalanced')
      ).toBe('atDefault');
      // a novel option that is SET (non-empty) still surfaces
      expect(ebOptionSettingTier('aws:x', 'Novel', 'set', 'LoadBalanced')).toBe('undeclared');
    });

    it('EnhancedHealthAuthEnabled folds value-independent (template reads false, environment true)', () => {
      const k = [
        'aws:elasticbeanstalk:healthreporting:system',
        'EnhancedHealthAuthEnabled',
      ] as const;
      expect(ebOptionSettingTier(k[0], k[1], 'false', 'LoadBalanced')).toBe('atDefault');
      expect(ebOptionSettingTier(k[0], k[1], 'true', 'SingleInstance')).toBe('atDefault');
    });

    it('platform-specific constants fold (PHP memory_limit, Python WSGIPath) and surface when changed', () => {
      expect(
        ebOptionSettingTier(
          'aws:elasticbeanstalk:container:php:phpini',
          'memory_limit',
          '256M',
          'LoadBalanced'
        )
      ).toBe('atDefault');
      expect(
        ebOptionSettingTier(
          'aws:elasticbeanstalk:container:php:phpini',
          'memory_limit',
          '512M',
          'LoadBalanced'
        )
      ).toBe('undeclared');
      expect(
        ebOptionSettingTier(
          'aws:elasticbeanstalk:container:python',
          'WSGIPath',
          'application',
          'LoadBalanced'
        )
      ).toBe('atDefault');
    });
  });

  describe('ElasticBeanstalk Application/Environment top-level first-run defaults (2026-07-07)', () => {
    it('an Application that declares no ResourceLifecycleConfig folds the disabled default to atDefault', () => {
      const T = 'AWS::ElasticBeanstalk::Application';
      const dflt = {
        VersionLifecycleConfig: {
          MaxCountRule: { DeleteSourceFromS3: false, Enabled: false, MaxCount: 200 },
          MaxAgeRule: { DeleteSourceFromS3: false, MaxAgeInDays: 180, Enabled: false },
        },
      };
      const t = tiers(
        classifyResource(
          res(T, { ApplicationName: 'app', Description: 'x' }),
          { ApplicationName: 'app', Description: 'x', ResourceLifecycleConfig: dflt },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual(['ResourceLifecycleConfig']);
      expect(t.undeclared).toEqual([]);
    });

    it('fail-closed: an ENABLED version-lifecycle rule out of band never folds to atDefault', () => {
      const T = 'AWS::ElasticBeanstalk::Application';
      const enabled = {
        VersionLifecycleConfig: {
          MaxCountRule: { DeleteSourceFromS3: true, Enabled: true, MaxCount: 200 },
          MaxAgeRule: { DeleteSourceFromS3: false, MaxAgeInDays: 180, Enabled: false },
        },
      };
      const t = tiers(
        classifyResource(
          res(T, { ApplicationName: 'app' }),
          { ApplicationName: 'app', ResourceLifecycleConfig: enabled },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual([]);
      expect(t.undeclared).toEqual(['ResourceLifecycleConfig']);
    });

    it('an Environment folds the default WebServer/Standard/1.0 Tier and the derived PlatformArn', () => {
      const T = 'AWS::ElasticBeanstalk::Environment';
      const t = tiers(
        classifyResource(
          res(T, {
            ApplicationName: 'app',
            EnvironmentName: 'env',
            SolutionStackName: '64bit Amazon Linux 2023 v4.13.3 running Docker',
          }),
          {
            ApplicationName: 'app',
            EnvironmentName: 'env',
            SolutionStackName: '64bit Amazon Linux 2023 v4.13.3 running Docker',
            Tier: { Type: 'Standard', Version: '1.0', Name: 'WebServer' },
            PlatformArn:
              'arn:aws:elasticbeanstalk:us-east-1::platform/Docker running on 64bit Amazon Linux 2023/4.13.3',
          },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual(['PlatformArn', 'Tier']);
      expect(t.undeclared).toEqual([]);
    });

    it('fail-closed: a Worker-tier Environment out of band never folds to atDefault', () => {
      const T = 'AWS::ElasticBeanstalk::Environment';
      const t = tiers(
        classifyResource(
          res(T, { ApplicationName: 'app', EnvironmentName: 'env' }),
          {
            ApplicationName: 'app',
            EnvironmentName: 'env',
            Tier: { Type: 'SQS/HTTP', Version: '1.0', Name: 'Worker' },
          },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual([]);
      expect(t.undeclared).toEqual(['Tier']);
    });
  });

  describe('classic ELB (ElasticLoadBalancing::LoadBalancer) first-run defaults (2026-07-07)', () => {
    const T = 'AWS::ElasticLoadBalancing::LoadBalancer';

    it('undeclared ConnectionSettings/ConnectionDrainingPolicy/AvailabilityZones fold to atDefault', () => {
      const t = tiers(
        classifyResource(
          res(T, { Scheme: 'internal', CrossZone: true }),
          {
            Scheme: 'internal',
            CrossZone: true,
            ConnectionSettings: { IdleTimeout: 60 },
            ConnectionDrainingPolicy: { Enabled: false, Timeout: 300 },
            AvailabilityZones: ['us-east-1a', 'us-east-1b'],
          },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual([
        'AvailabilityZones',
        'ConnectionDrainingPolicy',
        'ConnectionSettings',
      ]);
      expect(t.undeclared).toEqual([]);
      expect(t.declared).toEqual([]);
    });

    it('fail-closed: a raised idle timeout / enabled draining out of band never folds', () => {
      const t = tiers(
        classifyResource(
          res(T, { Scheme: 'internal' }),
          {
            Scheme: 'internal',
            ConnectionSettings: { IdleTimeout: 120 },
            ConnectionDrainingPolicy: { Enabled: true, Timeout: 300 },
          },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual([]);
      expect(t.undeclared).toEqual(['ConnectionDrainingPolicy', 'ConnectionSettings']);
    });

    it('value-independent: AvailabilityZones folds at any AZ placement (subnet-derived echo)', () => {
      const t = tiers(
        classifyResource(
          res(T, { Scheme: 'internal' }),
          { Scheme: 'internal', AvailabilityZones: ['eu-west-1b', 'eu-west-1c'] },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual(['AvailabilityZones']);
      expect(t.undeclared).toEqual([]);
    });

    it('value-independent: an AWS-assigned SSL negotiation Policies bag folds (HTTPS listener)', () => {
      const t = tiers(
        classifyResource(
          res(T, { Scheme: 'internet-facing' }),
          {
            Scheme: 'internet-facing',
            Policies: [
              {
                PolicyType: 'SSLNegotiationPolicyType',
                PolicyName: 'ELBSecurityPolicy-2016-08',
                Attributes: [{ Name: 'Protocol-TLSv1.2', Value: 'true' }],
              },
            ],
          },
          emptySchema
        )
      );
      expect(t.atDefault).toEqual(['Policies']);
      expect(t.undeclared).toEqual([]);
    });

    it('declared listener Protocol/InstanceProtocol are compared case-insensitively (no FP)', () => {
      const t = tiers(
        classifyResource(
          res(T, {
            Listeners: [
              {
                LoadBalancerPort: '80',
                InstancePort: '80',
                Protocol: 'http',
                InstanceProtocol: 'http',
              },
            ],
          }),
          {
            Listeners: [
              {
                LoadBalancerPort: '80',
                InstancePort: '80',
                Protocol: 'HTTP',
                InstanceProtocol: 'HTTP',
                PolicyNames: [],
              },
            ],
          },
          emptySchema
        )
      );
      expect(t.declared).toEqual([]);
    });

    it('fail-closed: a genuinely changed listener protocol (HTTP->TCP) still surfaces as declared drift', () => {
      const t = tiers(
        classifyResource(
          res(T, {
            Listeners: [{ LoadBalancerPort: '80', InstancePort: '80', Protocol: 'http' }],
          }),
          {
            Listeners: [{ LoadBalancerPort: '80', InstancePort: '80', Protocol: 'TCP' }],
          },
          emptySchema
        )
      );
      expect(t.declared).toEqual(['Listeners.0.Protocol']);
    });
  });

  describe('VpcLattice ServiceNetwork SharingConfig service default (#483)', () => {
    const T = 'AWS::VpcLattice::ServiceNetwork';

    it('an undeclared SharingConfig at the service default {enabled:true} folds to atDefault', () => {
      const findings = classifyResource(
        res(T, { Name: 'sn', AuthType: 'NONE' }),
        { Name: 'sn', AuthType: 'NONE', SharingConfig: { enabled: true } },
        emptySchema
      );
      const atDefault = findings.filter((f) => f.tier === 'atDefault');
      expect(atDefault.map((f) => f.path)).toEqual(['SharingConfig']);
      expect(findings.filter((f) => f.tier === 'undeclared')).toEqual([]);
    });

    it('fail-closed: sharing disabled out of band ({enabled:false}) never folds to atDefault', () => {
      // {enabled:false} is all-falsy, so the generic trivial-empty suppression already
      // keeps it out of the undeclared inventory (pre-existing behavior) — the guard
      // this pins is that the equality-gated KNOWN_DEFAULTS entry must not claim it as
      // "at the AWS default" (it is the opposite of the default).
      const findings = classifyResource(
        res(T, { Name: 'sn', AuthType: 'NONE' }),
        { Name: 'sn', AuthType: 'NONE', SharingConfig: { enabled: false } },
        emptySchema
      );
      expect(findings.filter((f) => f.tier === 'atDefault')).toEqual([]);
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

  // #502: ECR RepositoryCreationTemplate declares `Prefix: "cdkrd-hunt/"` (S3-prefix
  // habit) but the service stores `"cdkrd-hunt"` — after the CC_IDENTIFIER_ADAPTERS
  // read succeeds, the residual Prefix diff is pure trailing-slash noise.
  describe('trailing-slash scalar path (ECR RepositoryCreationTemplate Prefix, #502)', () => {
    const T = 'AWS::ECR::RepositoryCreationTemplate';

    it('declared `cdkrd-hunt/` vs live `cdkrd-hunt` is NOT drift', () => {
      expect(
        classifyResource(res(T, { Prefix: 'cdkrd-hunt/' }), { Prefix: 'cdkrd-hunt' }, emptySchema)
      ).toEqual([]);
    });

    it('a genuinely different prefix is still drift', () => {
      expect(
        tiers(classifyResource(res(T, { Prefix: 'cdkrd-hunt/' }), { Prefix: 'other' }, emptySchema))
          .declared
      ).toEqual(['Prefix']);
    });

    it('the rule is scoped per-type+path (other types stay strict)', () => {
      expect(
        tiers(
          classifyResource(
            res('AWS::ECR::Repository', { RepositoryName: 'x/' }),
            { RepositoryName: 'x' },
            emptySchema
          )
        ).declared
      ).toEqual(['RepositoryName']);
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

  // Observed live on fresh (non-imported) Aurora stacks: RDS lowercases DB
  // identifiers on creation, so a mixed-case declared identifier (CDK derives it
  // from the construct id) reads back all-lowercase — a case-only, unenforceable
  // difference.
  describe('case-insensitive scalar path (RDS DB identifiers)', () => {
    it('mixed-case declared DBInstanceIdentifier vs lowercase live is NOT drift', () => {
      expect(
        classifyResource(
          res('AWS::RDS::DBInstance', { DBInstanceIdentifier: 'my-app-UserStore-DB-writer' }),
          { DBInstanceIdentifier: 'my-app-userstore-db-writer' },
          emptySchema
        )
      ).toEqual([]);
    });

    it('mixed-case declared DBClusterIdentifier vs lowercase live is NOT drift', () => {
      expect(
        classifyResource(
          res('AWS::RDS::DBCluster', { DBClusterIdentifier: 'My-App-Database' }),
          { DBClusterIdentifier: 'my-app-database' },
          emptySchema
        )
      ).toEqual([]);
    });

    it('a genuinely different DBInstanceIdentifier is still drift', () => {
      expect(
        tiers(
          classifyResource(
            res('AWS::RDS::DBInstance', { DBInstanceIdentifier: 'my-app-primary' }),
            { DBInstanceIdentifier: 'my-app-replica' },
            emptySchema
          )
        ).declared
      ).toEqual(['DBInstanceIdentifier']);
    });
  });

  // Found live by the #500 SDK_OVERRIDES reader live-test: DMS DescribeEndpoints echoes
  // EndpointType UPPERCASE (source -> SOURCE), which the reader surfaces verbatim — a
  // case-echo declared-drift FP on every fresh endpoint. Folded via CASE_INSENSITIVE_PATHS.
  describe('case-insensitive scalar path (DMS Endpoint EndpointType, #500 reader)', () => {
    const T = 'AWS::DMS::Endpoint';

    it('lowercase declared `source` vs uppercase live `SOURCE` is NOT drift', () => {
      expect(
        classifyResource(
          res(T, { EndpointType: 'source' }),
          { EndpointType: 'SOURCE' },
          emptySchema
        )
      ).toEqual([]);
    });

    it('a genuinely different EndpointType (source vs target) is still drift', () => {
      expect(
        tiers(
          classifyResource(
            res(T, { EndpointType: 'source' }),
            { EndpointType: 'TARGET' },
            emptySchema
          )
        ).declared
      ).toEqual(['EndpointType']);
    });
  });

  // Found live by the xfer-sync hunt fixture (#494): the Cloud Control read handler
  // remaps DataBrew Recipe Steps[].Action.Parameters free-form map keys to PascalCase
  // (SourceColumn) while the template AND the DataBrew service carry camelCase
  // (sourceColumn) — a permanent declared-drift FP + an unrevertable revert loop. Folding
  // the key-case in normalize makes check clean, so revert detects no drift (no revert-code
  // change needed).
  describe('case-insensitive free-form map KEY path (DataBrew Recipe Steps Action Parameters, #494)', () => {
    const T = 'AWS::DataBrew::Recipe';
    const steps = (params: Record<string, unknown>[]) => ({
      Steps: params.map((p) => ({ Action: { Operation: 'RENAME', Parameters: p } })),
    });

    it('camelCase declared vs PascalCase live map keys (equal values) is NOT drift', () => {
      expect(
        classifyResource(
          res(
            T,
            steps([{ sourceColumn: 'field1' }, { sourceColumn: 'field1', targetColumn: 'field2' }])
          ),
          steps([{ SourceColumn: 'field1' }, { SourceColumn: 'field1', TargetColumn: 'field2' }]),
          emptySchema
        )
      ).toEqual([]);
    });

    it('a real value change under a matched key still surfaces (equality-gated per key-pair)', () => {
      expect(
        tiers(
          classifyResource(
            res(T, steps([{ sourceColumn: 'field1' }])),
            steps([{ SourceColumn: 'CHANGED' }]),
            emptySchema
          )
        ).declared
      ).toEqual(['Steps.0.Action.Parameters']);
    });

    it('a real key add still surfaces', () => {
      expect(
        tiers(
          classifyResource(
            res(T, steps([{ sourceColumn: 'field1' }])),
            steps([{ SourceColumn: 'field1', Extra: 'x' }]),
            emptySchema
          )
        ).declared
      ).toEqual(['Steps.0.Action.Parameters']);
    });

    it('the key-case rule is scoped per-type+path (other types stay strict)', () => {
      // the same map shape on an UNLISTED type keeps case-sensitive semantics
      expect(
        tiers(
          classifyResource(
            res('AWS::Other::Thing', {
              Steps: [{ Action: { Operation: 'X', Parameters: { sourceColumn: 'field1' } } }],
            }),
            { Steps: [{ Action: { Operation: 'X', Parameters: { SourceColumn: 'field1' } } }] },
            emptySchema
          )
        ).declared
      ).toEqual(['Steps.0.Action.Parameters']);
    });
  });

  // #491: RedshiftServerless Workgroup's echo attribute is a full self-echo whose leaves
  // are readOnly-stripped, leaving a `[{},{}]` husk (Endpoint) plus a constant default
  // (PricePerformanceTarget). The extended isTrivialEmpty folds the ENI husk regardless of
  // per-deploy count; matchesKnownDefault skips it and matches only the meaningful sub-key.
  describe('RedshiftServerless Workgroup echo-attribute strip husk folds to atDefault (#491)', () => {
    const T = 'AWS::RedshiftServerless::Workgroup';
    const husk = (status: string, eniCount: number) => ({
      Workgroup: {
        Endpoint: {
          VpcEndpoints: [{ NetworkInterfaces: Array.from({ length: eniCount }, () => ({})) }],
        },
        PricePerformanceTarget: { Status: status },
      },
    });

    it('the [{},{}] husk + DISABLED price target folds (never drift, never recorded)', () => {
      const t = tiers(
        classifyResource(res(T, { WorkgroupName: 'wg' }), husk('DISABLED', 2), emptySchema)
      );
      expect(t.atDefault).toEqual(['Workgroup']);
      expect(t.undeclared).toEqual([]);
    });

    it('the fold is resilient to a per-deploy ENI-count change (no latent FP)', () => {
      // a 3-ENI shape (AZ rebalance / capacity change) still folds — the shape is not pinned.
      expect(
        tiers(classifyResource(res(T, { WorkgroupName: 'wg' }), husk('DISABLED', 3), emptySchema))
          .atDefault
      ).toEqual(['Workgroup']);
    });

    it('a price-performance target ENABLED out of band still surfaces (equality-gated)', () => {
      expect(
        tiers(classifyResource(res(T, { WorkgroupName: 'wg' }), husk('ENABLED', 2), emptySchema))
          .undeclared
      ).toEqual(['Workgroup']);
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

  // #874: AWS::Lambda::Url exhibits the same platform behavior as apigwv2 (#257) —
  // the Function URL CORS header lists (`Cors.AllowHeaders` / `Cors.ExposeHeaders`)
  // are stored/echoed LOWERCASED, so a declared `["Content-Type","Authorization"]`
  // reads back `["content-type","authorization"]` and false-flagged declared drift.
  describe('case-insensitive header-name array path (Lambda Url CORS AllowHeaders/ExposeHeaders)', () => {
    const T = 'AWS::Lambda::Url';
    const cors = (headers: string[]) => ({
      Cors: { AllowHeaders: headers, AllowMethods: ['GET', 'POST'] },
    });

    it('mixed-case declared vs lowercase live CORS AllowHeaders is NOT drift', () => {
      expect(
        classifyResource(
          res(T, cors(['Content-Type', 'X-Custom-Header', 'Authorization'])),
          cors(['content-type', 'x-custom-header', 'authorization']),
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
      ).toEqual(['Cors.AllowHeaders']);
    });

    it('ExposeHeaders is folded case-insensitively too', () => {
      const expose = (h: string[]) => ({ Cors: { ExposeHeaders: h } });
      expect(
        classifyResource(
          res(T, expose(['X-Request-Id', 'Content-Length'])),
          expose(['x-request-id', 'content-length']),
          emptySchema
        )
      ).toEqual([]);
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

  // Found live by the lambda-efs-rich bug-hunt fixture: an EFS AccessPoint's ClientToken
  // is the idempotency token CloudFormation mints at create time (`<logicalId>-<random>`).
  // It is createOnly (immutable) and the CDK L2 never declares it, so it is live-only on
  // every AccessPoint; without folding it floods the first run as undeclared. The value is
  // opaque (not derivable from the fsap-… ARN physical id), so it folds via the
  // value-independent GENERATED_TOPLEVEL_PATHS, not isGeneratedName.
  describe('value-independent generated top-level path (EFS AccessPoint ClientToken)', () => {
    const T = 'AWS::EFS::AccessPoint';

    it('a live-only AccessPoint ClientToken folds as generated (not undeclared/drift)', () => {
      const t = tiers(
        classifyResource(
          res(T, { FileSystemId: 'fs-123' }),
          { FileSystemId: 'fs-123', ClientToken: 'AccessPointE936DE82-b6xKi37R0Uio' },
          emptySchema
        )
      );
      expect(t.generated).toEqual(['ClientToken']);
      expect(t.undeclared).toEqual([]);
    });

    it('a DIFFERENT token still folds (value-independent — opaque, not id-derived)', () => {
      const t = tiers(
        classifyResource(
          res(T, { FileSystemId: 'fs-123' }),
          { FileSystemId: 'fs-123', ClientToken: 'FsApCFF9572D-dRkYh637cpxN' },
          emptySchema
        )
      );
      expect(t.generated).toEqual(['ClientToken']);
      expect(t.undeclared).toEqual([]);
    });

    it('the fold is scoped per-type (a ClientToken on another type stays undeclared)', () => {
      expect(
        tiers(classifyResource(res('AWS::S3::Bucket', {}), { ClientToken: 'abc-123' }, emptySchema))
          .undeclared
      ).toEqual(['ClientToken']);
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

  describe('Cognito UserPoolResourceServer Scopes (ScopeName-keyed reordered set, cognito-userpool-sets)', () => {
    const T = 'AWS::Cognito::UserPoolResourceServer';
    // declared in scrambled (non-alphabetical) order; AWS echoes the set SORTED by
    // ScopeName. ScopeName is NOT an IDENTITY_FIELD, so only the per-type fold aligns it.
    const declared = {
      Scopes: [
        { ScopeName: 'zeta.write', ScopeDescription: 'zeta scope' },
        { ScopeName: 'alpha.read', ScopeDescription: 'alpha scope' },
        { ScopeName: 'mike.admin', ScopeDescription: 'mike scope' },
      ],
    };

    it('AWS returning the Scopes sorted by ScopeName is NOT drift', () => {
      const live = {
        Scopes: [
          { ScopeName: 'alpha.read', ScopeDescription: 'alpha scope' },
          { ScopeName: 'mike.admin', ScopeDescription: 'mike scope' },
          { ScopeName: 'zeta.write', ScopeDescription: 'zeta scope' },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine scope change (a renamed ScopeName) still surfaces', () => {
      const live = {
        Scopes: [
          { ScopeName: 'alpha.read', ScopeDescription: 'alpha scope' },
          { ScopeName: 'mike.admin', ScopeDescription: 'mike scope' },
          { ScopeName: 'zeta.delete', ScopeDescription: 'zeta scope' }, // write -> delete
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });

    it('editing a scope DESCRIPTION reports exactly ONE aligned drift, not a misaligned smear (identity-first sort)', () => {
      // ScopeDescription sorts BEFORE ScopeName in canonical JSON (D < N), so a plain
      // canonical-JSON sort would move the edited element and MISALIGN the positional diff —
      // false-flagging the UNCHANGED ScopeNames of other scopes too. Keying the sort on the
      // ScopeName identity keeps every element aligned; only zeta.write's description differs.
      const live = {
        Scopes: [
          { ScopeName: 'alpha.read', ScopeDescription: 'alpha scope' },
          { ScopeName: 'mike.admin', ScopeDescription: 'mike scope' },
          { ScopeName: 'zeta.write', ScopeDescription: 'HACKED zeta' }, // description only
        ],
      };
      // exactly one drift, on the TEMPLATE index 0 (zeta.write is declared first), the
      // description — the ScopeName is NOT falsely reported.
      expect(declaredTiers(T, declared, live)).toEqual(['Scopes.0.ScopeDescription']);
    });
  });

  // An Access Analyzer's `ArchiveRules` is a SET of {RuleName, Filter} AWS echoes
  // SORTED by RuleName, not in template order (found by accessanalyzer-iot-rich:
  // declared [ArchiveNonPublic, ArchiveKnownPrincipal] read back alphabetical —
  // 4 false declared drifts on a 2-rule analyzer). RuleName is NOT an
  // IDENTITY_FIELD; since #459 the fold is SCHEMA-DRIVEN — the real Analyzer schema
  // marks ArchiveRules insertionOrder:false with non-identity object items, so
  // parseSchema collects it into unorderedObjectArrayPaths (mirrored here) and the
  // per-type UNORDERED_OBJECT_ARRAY_PROPS entry was removed.
  describe('AccessAnalyzer Analyzer ArchiveRules (RuleName-keyed reordered set, found by accessanalyzer-iot-rich)', () => {
    const T = 'AWS::AccessAnalyzer::Analyzer';
    const analyzerSchema: SchemaInfo = {
      ...emptySchema,
      unorderedObjectArrayPaths: ['ArchiveRules'],
    };
    const declaredTiers = (
      rt: string,
      declared: Record<string, unknown>,
      live: Record<string, unknown>
    ) =>
      classifyResource(res(rt, declared), live, analyzerSchema)
        .filter((f) => f.tier === 'declared')
        .map((f) => f.path);
    const declared = {
      Type: 'ACCOUNT',
      ArchiveRules: [
        { RuleName: 'ArchiveNonPublic', Filter: [{ Property: 'isPublic', Eq: ['false'] }] },
        {
          RuleName: 'ArchiveKnownPrincipal',
          Filter: [
            { Property: 'principal.AWS', Contains: ['999988887777'] },
            { Property: 'resourceType', Eq: ['AWS::S3::Bucket'] },
          ],
        },
      ],
    };

    it('AWS returning the ArchiveRules sorted by RuleName is NOT drift', () => {
      const live = {
        Type: 'ACCOUNT',
        ArchiveRules: [declared.ArchiveRules[1], declared.ArchiveRules[0]],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine rule change (an edited Filter value) still surfaces', () => {
      const live = {
        Type: 'ACCOUNT',
        ArchiveRules: [
          {
            RuleName: 'ArchiveKnownPrincipal',
            Filter: [
              { Property: 'principal.AWS', Contains: ['111122223333'] }, // account edited
              { Property: 'resourceType', Eq: ['AWS::S3::Bucket'] },
            ],
          },
          declared.ArchiveRules[0],
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  // An IAM principal's inline `Policies` is a SET of {PolicyName, PolicyDocument}
  // AWS returns SORTED by PolicyName, not in template order (found by
  // iam-permboundary-rich: declared [readObjects, describeOnly] read back
  // [describeOnly, readObjects]). PolicyName is NOT an IDENTITY_FIELD, so only the
  // per-type fold aligns it. The same inline-policy-set shape lives on Role/User/Group.
  describe('IAM Role/User/Group inline Policies (PolicyName-keyed reordered set, found by iam-permboundary-rich)', () => {
    const declared = {
      Policies: [
        {
          PolicyName: 'readObjects',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: '*' },
            ],
          },
        },
        {
          PolicyName: 'describeOnly',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['ec2:DescribeInstances', 'ec2:DescribeTags'],
                Resource: '*',
              },
            ],
          },
        },
      ],
    };
    // AWS echoes the set sorted by PolicyName: describeOnly before readObjects.
    const liveSorted = {
      Policies: [declared.Policies[1], declared.Policies[0]],
    };

    for (const T of ['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group']) {
      it(`${T}: AWS returning the inline Policies sorted by PolicyName is NOT drift`, () => {
        expect(declaredTiers(T, declared, liveSorted)).toEqual([]);
      });

      it(`${T}: a genuine inline-policy change (an added Action) still surfaces`, () => {
        const liveChanged = {
          Policies: [
            {
              PolicyName: 'describeOnly',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    // s3:DeleteObject added out of band
                    Action: ['ec2:DescribeInstances', 'ec2:DescribeTags', 's3:DeleteObject'],
                    Resource: '*',
                  },
                ],
              },
            },
            declared.Policies[0],
          ],
        };
        expect(declaredTiers(T, declared, liveChanged).length).toBeGreaterThan(0);
      });
    }
  });

  // A Redshift ClusterParameterGroup's `Parameters` is a SET of {ParameterName,
  // ParameterValue} AWS returns SORTED by ParameterName (found by
  // redshift-paramgroup-reorder: declared [require_ssl, enable_user_activity_logging,
  // max_concurrency_scaling_clusters] read back alphabetically). ParameterName is NOT
  // an IDENTITY_FIELD, so only the per-type fold aligns it.
  describe('Redshift ClusterParameterGroup Parameters (ParameterName-keyed reordered set)', () => {
    const T = 'AWS::Redshift::ClusterParameterGroup';
    const declared = {
      Parameters: [
        { ParameterName: 'require_ssl', ParameterValue: 'true' },
        { ParameterName: 'enable_user_activity_logging', ParameterValue: 'true' },
        { ParameterName: 'max_concurrency_scaling_clusters', ParameterValue: '1' },
      ],
    };

    it('AWS returning the Parameters sorted by ParameterName is NOT drift', () => {
      const live = {
        Parameters: [
          { ParameterName: 'enable_user_activity_logging', ParameterValue: 'true' },
          { ParameterName: 'max_concurrency_scaling_clusters', ParameterValue: '1' },
          { ParameterName: 'require_ssl', ParameterValue: 'true' },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine parameter value change still surfaces (even when reordered)', () => {
      const live = {
        Parameters: [
          { ParameterName: 'enable_user_activity_logging', ParameterValue: 'false' }, // true -> false
          { ParameterName: 'max_concurrency_scaling_clusters', ParameterValue: '1' },
          { ParameterName: 'require_ssl', ParameterValue: 'true' },
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

    it('reports the drift at the TEMPLATE index even when the drifted element has its OWN reordered nested set (remap via nested-sorted source)', () => {
      // path-pattern is declared FIRST (template index 0) with its Values in NON-sorted
      // order, but sorts AFTER host-header (canonical "host-header" < "path-pattern") to
      // sorted index 1 — AND its Values sub-set is itself re-sorted. A plain deep-equal vs
      // the raw declared array would then fail to locate the element (the sorted element's
      // Values no longer match the raw element's order) and fall back to the sorted index.
      // remapSortedIndexToDeclared must match against the nested-sorted-but-raw-top-order
      // source and report `Conditions.0.…` (the user's template position).
      const declaredUnsorted = {
        Conditions: [
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/v2/*', '/api/*'] } },
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        ],
      };
      const live = {
        Conditions: [
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/CHANGED/*', '/api/*'] } },
        ],
      };
      const paths = declaredTiers(T, declaredUnsorted, live);
      expect(paths.length).toBeGreaterThan(0);
      // every reported path uses the TEMPLATE index (0 = path-pattern), not the sorted index (1)
      expect(paths.every((p) => p.startsWith('Conditions.0.'))).toBe(true);
    });
  });

  // A path-pattern condition's `Values` is a SET ALB reorders into its own canonical
  // order (found by elbv2-rule-values: declared ["/zebra/*","/alpha/*","/mango/*"] read
  // back ["/alpha/*","/zebra/*","/mango/*"]). The set is nested under the Conditions
  // ARRAY, which is ITSELF an unordered object set — so this exercises the compose path
  // (inner Values sorted first, then the Conditions array sorted by canonical JSON).
  describe('ELBv2 ListenerRule nested PathPatternConfig.Values set (found by elbv2-rule-values)', () => {
    const T = 'AWS::ElasticLoadBalancingV2::ListenerRule';
    const declared = {
      Conditions: [
        {
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/zebra/*', '/alpha/*', '/mango/*'] },
        },
        { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
      ],
    };

    it('ALB reordering the nested Values set is NOT drift', () => {
      const live = {
        Conditions: [
          {
            Field: 'path-pattern',
            PathPatternConfig: { Values: ['/alpha/*', '/zebra/*', '/mango/*'] },
          },
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('Values reorder AND Conditions reorder together is NOT drift (compose)', () => {
      const live = {
        Conditions: [
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
          {
            Field: 'path-pattern',
            PathPatternConfig: { Values: ['/mango/*', '/alpha/*', '/zebra/*'] },
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine Values change still surfaces (no over-fold)', () => {
      const live = {
        Conditions: [
          {
            Field: 'path-pattern',
            PathPatternConfig: { Values: ['/alpha/*', '/zebra/*', '/CHANGED/*'] },
          },
          { Field: 'host-header', HostHeaderConfig: { Values: ['example.com'] } },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('ELBv2 ListenerRule SourceIp/HttpHeader/QueryString condition Values (found by elbv2-rule-conditions)', () => {
    const T = 'AWS::ElasticLoadBalancingV2::ListenerRule';

    it('a source-ip CIDR Values set returned reordered is NOT drift', () => {
      const declared = {
        Conditions: [
          {
            Field: 'source-ip',
            SourceIpConfig: { Values: ['10.3.0.0/16', '10.1.0.0/16', '10.2.0.0/16'] },
          },
        ],
      };
      const live = {
        Conditions: [
          {
            Field: 'source-ip',
            SourceIpConfig: { Values: ['10.3.0.0/16', '10.2.0.0/16', '10.1.0.0/16'] },
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('an http-header Values set returned reordered is NOT drift', () => {
      const declared = {
        Conditions: [
          {
            Field: 'http-header',
            HttpHeaderConfig: { HttpHeaderName: 'X-Cdkrd', Values: ['zeta', 'alpha', 'mike'] },
          },
        ],
      };
      const live = {
        Conditions: [
          {
            Field: 'http-header',
            HttpHeaderConfig: { HttpHeaderName: 'X-Cdkrd', Values: ['zeta', 'mike', 'alpha'] },
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a query-string {Key,Value} set returned reordered is NOT drift (Key is an IDENTITY_FIELD, auto-aligned)', () => {
      const declared = {
        Conditions: [
          {
            Field: 'query-string',
            QueryStringConfig: {
              Values: [
                { Key: 'zeta', Value: '1' },
                { Key: 'alpha', Value: '2' },
                { Key: 'mike', Value: '3' },
              ],
            },
          },
        ],
      };
      const live = {
        Conditions: [
          {
            Field: 'query-string',
            QueryStringConfig: {
              Values: [
                { Key: 'mike', Value: '3' },
                { Key: 'alpha', Value: '2' },
                { Key: 'zeta', Value: '1' },
              ],
            },
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine source-ip CIDR change still surfaces (no over-fold)', () => {
      const declared = {
        Conditions: [
          { Field: 'source-ip', SourceIpConfig: { Values: ['10.3.0.0/16', '10.1.0.0/16'] } },
        ],
      };
      const live = {
        Conditions: [
          { Field: 'source-ip', SourceIpConfig: { Values: ['10.9.0.0/16', '10.1.0.0/16'] } }, // 10.3 -> 10.9
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('AutoScaling group inline LifecycleHookSpecificationList reordered (object set keyed by LifecycleHookName ∉ IDENTITY_FIELDS, found by asg-lifecyclehook-inline)', () => {
    const T = 'AWS::AutoScaling::AutoScalingGroup';
    const declared = {
      LifecycleHookSpecificationList: [
        {
          LifecycleHookName: 'zeta-terminate',
          LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
          DefaultResult: 'CONTINUE',
        },
        {
          LifecycleHookName: 'alpha-launch',
          LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING',
          DefaultResult: 'CONTINUE',
        },
      ],
    };

    it('AWS returning the hook list sorted by LifecycleHookName is NOT drift', () => {
      const live = {
        LifecycleHookSpecificationList: [
          {
            LifecycleHookName: 'alpha-launch',
            LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING',
            DefaultResult: 'CONTINUE',
          },
          {
            LifecycleHookName: 'zeta-terminate',
            LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
            DefaultResult: 'CONTINUE',
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine hook transition change still surfaces (no over-fold)', () => {
      const live = {
        LifecycleHookSpecificationList: [
          {
            LifecycleHookName: 'alpha-launch',
            LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING',
            DefaultResult: 'ABANDON',
          }, // CONTINUE -> ABANDON
          {
            LifecycleHookName: 'zeta-terminate',
            LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
            DefaultResult: 'CONTINUE',
          },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('SecretsManager Secret ReplicaRegions reordered (object set keyed by Region ∉ IDENTITY_FIELDS, found by secret-replica-regions)', () => {
    const T = 'AWS::SecretsManager::Secret';
    const declared = {
      ReplicaRegions: [{ Region: 'us-west-2' }, { Region: 'eu-west-1' }],
    };

    it('AWS returning ReplicaRegions sorted by Region is NOT drift', () => {
      const live = { ReplicaRegions: [{ Region: 'eu-west-1' }, { Region: 'us-west-2' }] };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine replica region change still surfaces (no over-fold)', () => {
      const live = { ReplicaRegions: [{ Region: 'eu-west-1' }, { Region: 'ap-south-1' }] }; // us-west-2 -> ap-south-1
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('ElastiCache CacheCluster LogDeliveryConfigurations reordered (object set keyed by LogType ∉ IDENTITY_FIELDS, found by elasticache-logdelivery)', () => {
    const T = 'AWS::ElastiCache::CacheCluster';
    const cfg = (logType: string, logGroup: string) => ({
      LogType: logType,
      LogFormat: 'json',
      DestinationType: 'cloudwatch-logs',
      DestinationDetails: { CloudWatchLogsDetails: { LogGroup: logGroup } },
    });
    const declared = {
      LogDeliveryConfigurations: [cfg('slow-log', 'slow-grp'), cfg('engine-log', 'engine-grp')],
    };

    it('Cloud Control returning the set reordered by LogType is NOT drift', () => {
      // Cloud Control echoes the configs alphabetically by LogType (engine-log first),
      // and the order is non-deterministic between reads — sorting both sides aligns them.
      const live = {
        LogDeliveryConfigurations: [cfg('engine-log', 'engine-grp'), cfg('slow-log', 'slow-grp')],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine destination change still surfaces (no over-fold)', () => {
      const live = {
        LogDeliveryConfigurations: [
          cfg('engine-log', 'engine-grp'),
          cfg('slow-log', 'CHANGED-grp'),
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('WAFv2 LoggingConfiguration RedactedFields reordered (discriminated-union FieldToMatch set, no identity field, found by wafv2-logging-rich)', () => {
    const T = 'AWS::WAFv2::LoggingConfiguration';
    const declared = {
      RedactedFields: [
        { SingleHeader: { Name: 'authorization' } },
        { Method: {} },
        { QueryString: {} },
      ],
    };

    it('WAF returning RedactedFields sorted by discriminator key is NOT drift', () => {
      // WAF echoes the fields alphabetically by their single object key
      // (Method, QueryString, SingleHeader) — sorting both sides aligns them.
      const live = {
        RedactedFields: [
          { Method: {} },
          { QueryString: {} },
          { SingleHeader: { Name: 'authorization' } },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine redacted-field change still surfaces (no over-fold)', () => {
      // authorization -> cookie header is a real change to a redacted field.
      const live = {
        RedactedFields: [{ Method: {} }, { QueryString: {} }, { SingleHeader: { Name: 'cookie' } }],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('EC2 PrefixList Entries reordered (object set keyed by Cidr ∉ IDENTITY_FIELDS, found by ec2-prefixlist-rich)', () => {
    const T = 'AWS::EC2::PrefixList';
    const declared = {
      Entries: [
        { Cidr: '10.0.0.0/16', Description: 'corp-a' },
        { Cidr: '10.1.0.0/16', Description: 'corp-b' },
        { Cidr: '192.168.0.0/24', Description: 'branch' },
      ],
    };

    it('AWS returning Entries reordered by an out-of-band modify is NOT drift', () => {
      // A ModifyManagedPrefixList reorders the set; the same entries in a different
      // order must not false-flag every shifted entry's Cidr/Description.
      const live = {
        Entries: [
          { Cidr: '192.168.0.0/24', Description: 'branch' },
          { Cidr: '10.1.0.0/16', Description: 'corp-b' },
          { Cidr: '10.0.0.0/16', Description: 'corp-a' },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine entry description change still surfaces (no over-fold), even when reordered', () => {
      // 10.1.0.0/16 description edited AND the set reordered — exactly one real drift.
      const live = {
        Entries: [
          { Cidr: '192.168.0.0/24', Description: 'branch' },
          { Cidr: '10.1.0.0/16', Description: 'HACKED' },
          { Cidr: '10.0.0.0/16', Description: 'corp-a' },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });

    it('reports the drift at the TEMPLATE index, not the sorted index (remapSortedIndexToDeclared)', () => {
      // Template order is deliberately NON-sorted: 192.168.0.0/24 is declared FIRST
      // (index 0) but sorts LAST (canonical JSON "10.0…" < "10.1…" < "192…"). Editing
      // its Description must report `Entries.0.…` (the user's template position), not the
      // sorted `Entries.2.…` — otherwise the index points at a different declared entry.
      const declaredUnsorted = {
        Entries: [
          { Cidr: '192.168.0.0/24', Description: 'branch' },
          { Cidr: '10.0.0.0/16', Description: 'corp-a' },
          { Cidr: '10.1.0.0/16', Description: 'corp-b' },
        ],
      };
      const live = {
        Entries: [
          { Cidr: '10.0.0.0/16', Description: 'corp-a' },
          { Cidr: '10.1.0.0/16', Description: 'corp-b' },
          { Cidr: '192.168.0.0/24', Description: 'CHANGED' },
        ],
      };
      expect(declaredTiers(T, declaredUnsorted, live)).toEqual(['Entries.0.Description']);
    });
  });

  describe('AutoScaling group MetricsCollection.Metrics / NotificationConfigurations.NotificationTypes reordered (nested scalar sets, found by asg-notification-metrics)', () => {
    const T = 'AWS::AutoScaling::AutoScalingGroup';

    it('a MetricsCollection Metrics set returned alphabetically sorted is NOT drift', () => {
      const declared = {
        MetricsCollection: [
          {
            Granularity: '1Minute',
            Metrics: [
              'GroupTotalInstances',
              'GroupDesiredCapacity',
              'GroupMaxSize',
              'GroupMinSize',
            ],
          },
        ],
      };
      const live = {
        MetricsCollection: [
          {
            Granularity: '1Minute',
            Metrics: [
              'GroupDesiredCapacity',
              'GroupMaxSize',
              'GroupMinSize',
              'GroupTotalInstances',
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a NotificationConfigurations NotificationTypes set returned sorted is NOT drift', () => {
      const declared = {
        NotificationConfigurations: [
          {
            TopicARN: 'arn:aws:sns:us-east-1:111111111111:t',
            NotificationTypes: [
              'autoscaling:EC2_INSTANCE_TERMINATE',
              'autoscaling:EC2_INSTANCE_LAUNCH',
              'autoscaling:EC2_INSTANCE_LAUNCH_ERROR',
            ],
          },
        ],
      };
      const live = {
        NotificationConfigurations: [
          {
            TopicARN: 'arn:aws:sns:us-east-1:111111111111:t',
            NotificationTypes: [
              'autoscaling:EC2_INSTANCE_LAUNCH',
              'autoscaling:EC2_INSTANCE_LAUNCH_ERROR',
              'autoscaling:EC2_INSTANCE_TERMINATE',
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine metric add still surfaces (no over-fold)', () => {
      const declared = {
        MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMaxSize', 'GroupMinSize'] }],
      };
      const live = {
        MetricsCollection: [
          {
            Granularity: '1Minute',
            Metrics: ['GroupMinSize', 'GroupMaxSize', 'GroupInServiceInstances'],
          },
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

  describe('ECS TaskDefinition PortMappings reordered inside a container (found by ecs-taskdef-caps)', () => {
    const T = 'AWS::ECS::TaskDefinition';
    // The reordered set lives one level under the ContainerDefinitions ARRAY — the nested
    // path crosses an array, which the Bedrock cases (object-under-object) never exercised.
    const declared = {
      ContainerDefinitions: [
        {
          Name: 'app',
          PortMappings: [
            { ContainerPort: 8080, HostPort: 8080, Protocol: 'tcp' },
            { ContainerPort: 443, HostPort: 443, Protocol: 'tcp' },
            { ContainerPort: 80, HostPort: 80, Protocol: 'tcp' },
          ],
        },
      ],
    };

    it('AWS returning a container PortMappings set in a different order is NOT drift', () => {
      const live = {
        ContainerDefinitions: [
          {
            Name: 'app',
            PortMappings: [
              { ContainerPort: 443, HostPort: 443, Protocol: 'tcp' },
              { ContainerPort: 8080, HostPort: 8080, Protocol: 'tcp' },
              { ContainerPort: 80, HostPort: 80, Protocol: 'tcp' },
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('the fold reaches PortMappings in EVERY container (multi-container, ContainerDefinitions also reordered by Name)', () => {
      const multi = {
        ContainerDefinitions: [
          { Name: 'app', PortMappings: [{ ContainerPort: 80 }, { ContainerPort: 443 }] },
          { Name: 'sidecar', PortMappings: [{ ContainerPort: 9090 }, { ContainerPort: 9091 }] },
        ],
      };
      const live = {
        ContainerDefinitions: [
          // ECS returns the containers themselves reordered (Name-keyed) AND each
          // container's PortMappings reordered.
          { Name: 'sidecar', PortMappings: [{ ContainerPort: 9091 }, { ContainerPort: 9090 }] },
          { Name: 'app', PortMappings: [{ ContainerPort: 443 }, { ContainerPort: 80 }] },
        ],
      };
      expect(declaredTiers(T, multi, live)).toEqual([]);
    });

    it('a genuine container-port change still surfaces (no over-fold)', () => {
      const live = {
        ContainerDefinitions: [
          {
            Name: 'app',
            PortMappings: [
              { ContainerPort: 443, HostPort: 443, Protocol: 'tcp' },
              { ContainerPort: 8443, HostPort: 8443, Protocol: 'tcp' }, // 8080 -> 8443
              { ContainerPort: 80, HostPort: 80, Protocol: 'tcp' },
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('ECS TaskDefinition VolumesFrom reordered inside a container (found by ecs-taskdef-mounts)', () => {
    const T = 'AWS::ECS::TaskDefinition';
    const declared = {
      ContainerDefinitions: [
        {
          Name: 'sidecar',
          VolumesFrom: [
            { SourceContainer: 'logger', ReadOnly: true },
            { SourceContainer: 'app', ReadOnly: false },
          ],
        },
      ],
    };

    it('AWS returning VolumesFrom (a SourceContainer set) reordered is NOT drift', () => {
      const live = {
        ContainerDefinitions: [
          {
            Name: 'sidecar',
            VolumesFrom: [
              { SourceContainer: 'app', ReadOnly: false },
              { SourceContainer: 'logger', ReadOnly: true },
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine VolumesFrom readOnly change still surfaces (no over-fold)', () => {
      const live = {
        ContainerDefinitions: [
          {
            Name: 'sidecar',
            VolumesFrom: [
              { SourceContainer: 'app', ReadOnly: true }, // false -> true
              { SourceContainer: 'logger', ReadOnly: true },
            ],
          },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('ECS TaskDefinition Links reordered inside a container (nested scalar set, found by ecs-taskdef-sets)', () => {
    const T = 'AWS::ECS::TaskDefinition';
    // `Links` is a SCALAR set (`name:alias` strings) nested under the
    // ContainerDefinitions ARRAY — like DynamoDB NonKeyAttributes but the values
    // aren't id/ARN/HTTP/AZ-shaped, so canonicalizeIdArraysDeep leaves them; ECS
    // echoes them sorted alphabetically.
    const declared = {
      ContainerDefinitions: [{ Name: 'app', Links: ['logger:log', 'init:setup'] }],
    };

    it('AWS returning a container Links set sorted alphabetically is NOT drift', () => {
      const live = {
        ContainerDefinitions: [{ Name: 'app', Links: ['init:setup', 'logger:log'] }],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine link add still surfaces (no over-fold)', () => {
      const live = {
        ContainerDefinitions: [{ Name: 'app', Links: ['init:setup', 'logger:log', 'cache:redis'] }],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('Backup BackupSelection ListOfTags reordered (object set keyed by ConditionKey ∉ IDENTITY_FIELDS, found by backup-selection)', () => {
    const T = 'AWS::Backup::BackupSelection';
    // The set is nested one OBJECT level under the top-level `BackupSelection` key — AWS
    // Backup echoes it sorted by ConditionKey, which is NOT an IDENTITY_FIELD.
    const declared = {
      BackupSelection: {
        SelectionName: 'sel',
        ListOfTags: [
          { ConditionType: 'STRINGEQUALS', ConditionKey: 'zeta', ConditionValue: '1' },
          { ConditionType: 'STRINGEQUALS', ConditionKey: 'alpha', ConditionValue: '2' },
          { ConditionType: 'STRINGEQUALS', ConditionKey: 'mike', ConditionValue: '3' },
        ],
      },
    };

    it('AWS returning ListOfTags sorted by ConditionKey is NOT drift', () => {
      const live = {
        BackupSelection: {
          SelectionName: 'sel',
          ListOfTags: [
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'alpha', ConditionValue: '2' },
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'mike', ConditionValue: '3' },
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'zeta', ConditionValue: '1' },
          ],
        },
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine ConditionValue change still surfaces (no over-fold)', () => {
      const live = {
        BackupSelection: {
          SelectionName: 'sel',
          ListOfTags: [
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'alpha', ConditionValue: '9' }, // 2 -> 9
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'mike', ConditionValue: '3' },
            { ConditionType: 'STRINGEQUALS', ConditionKey: 'zeta', ConditionValue: '1' },
          ],
        },
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('DynamoDB GSI Projection.NonKeyAttributes reordered (nested scalar set, found by ddb-gsi-projection)', () => {
    const T = 'AWS::DynamoDB::Table';
    // The reordered set is a SCALAR array nested under the GlobalSecondaryIndexes ARRAY
    // and one object level (Projection) — exercises both the array-crossing and the
    // scalar-array branch of sortNestedObjectArrays.
    const declared = {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: ['zeta', 'alpha', 'mike', 'bravo'],
          },
        },
      ],
    };

    it('AWS returning NonKeyAttributes alphabetically sorted is NOT drift', () => {
      const live = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: ['alpha', 'bravo', 'mike', 'zeta'],
            },
          },
        ],
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine NonKeyAttributes change still surfaces (no over-fold)', () => {
      const live = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: ['alpha', 'bravo', 'mike', 'omega'], // zeta -> omega
            },
          },
        ],
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  describe('Lambda EventSourceMapping KafkaBootstrapServers reordered (nested scalar set under SelfManagedEventSource.Endpoints, found by esm-sourceaccess-rich)', () => {
    const T = 'AWS::Lambda::EventSourceMapping';
    const declared = {
      SelfManagedEventSource: {
        Endpoints: {
          KafkaBootstrapServers: ['b-1.cdkrd.example.com:9092', 'b-2.cdkrd.example.com:9092'],
        },
      },
    };

    it('Lambda returning the bootstrap-server set reordered is NOT drift', () => {
      const live = {
        SelfManagedEventSource: {
          Endpoints: {
            KafkaBootstrapServers: ['b-2.cdkrd.example.com:9092', 'b-1.cdkrd.example.com:9092'],
          },
        },
      };
      expect(declaredTiers(T, declared, live)).toEqual([]);
    });

    it('a genuine broker change still surfaces (no over-fold)', () => {
      const live = {
        SelfManagedEventSource: {
          Endpoints: {
            KafkaBootstrapServers: ['b-2.cdkrd.example.com:9092', 'b-3.cdkrd.example.com:9092'],
          },
        },
      };
      expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
    });
  });

  // The siblings of the GSI fold above, found by ddb-nested-sets: the SAME nested
  // INCLUDE-projection NonKeyAttributes set lives on a Table's LocalSecondaryIndexes
  // and on the AWS::DynamoDB::GlobalTable (TableV2) type's GSI *and* LSI, all of which
  // AWS reorders into its own canonical order (declared ["yankee","bravo","oscar",
  // "delta"] read back ["oscar","delta","yankee","bravo"], etc.). Each must fold the
  // reorder yet still surface a genuine element change.
  describe('DynamoDB nested NonKeyAttributes sibling sets reordered (found by ddb-nested-sets)', () => {
    const idx = (arrKey: string, attrs: string[]) => ({
      [arrKey]: [
        { IndexName: 'idx1', Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: attrs } },
      ],
    });
    const cases = [
      { T: 'AWS::DynamoDB::Table', arrKey: 'LocalSecondaryIndexes' },
      { T: 'AWS::DynamoDB::GlobalTable', arrKey: 'GlobalSecondaryIndexes' },
      { T: 'AWS::DynamoDB::GlobalTable', arrKey: 'LocalSecondaryIndexes' },
    ];
    for (const { T, arrKey } of cases) {
      const declared = idx(arrKey, ['yankee', 'bravo', 'oscar', 'delta']);
      it(`${T} ${arrKey}: reordered NonKeyAttributes set is NOT drift`, () => {
        const live = idx(arrKey, ['oscar', 'delta', 'yankee', 'bravo']);
        expect(declaredTiers(T, declared, live)).toEqual([]);
      });
      it(`${T} ${arrKey}: a genuine NonKeyAttributes change still surfaces`, () => {
        const live = idx(arrKey, ['oscar', 'delta', 'yankee', 'omega']); // bravo -> omega
        expect(declaredTiers(T, declared, live).length).toBeGreaterThan(0);
      });
    }
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
        // out-of-band non-default value (default is "false") -> must NOT fold to atDefault
        { Key: 'waf.fail_open.enabled', Value: 'true' },
      ],
    };
    const findings = classifyResource(res(T, declared), liveAll, emptySchema);
    // the 2 declared keys match -> NO declared (false) drift
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // R95 fail-closed: a live-only key NOT at its default still surfaces as undeclared
    // inventory (reported, not hidden), while the at-default keys fold to atDefault.
    expect(findings.filter((f) => f.tier === 'undeclared').map((f) => f.path)).toEqual([
      'LoadBalancerAttributes[waf.fail_open.enabled]',
    ]);
    expect(
      findings
        .filter((f) => f.tier === 'atDefault')
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

  it('a live-only key under a FREE-FORM MAP property is flagged freeFormKey (surfaced, not folded)', () => {
    // The reported Lambda Environment.Variables case: a console-added env var is a real,
    // reviewable value (every map key is user-authored), so it carries freeFormKey -> the
    // report shows it in full rather than folding it into the undeclared-subkey count.
    const schema: SchemaInfo = { ...emptySchema, freeFormMapPaths: ['Environment.Variables'] };
    const out = classifyResource(
      res('AWS::Lambda::Function', {
        Environment: { Variables: { USER_POOL_ID: '/a/b' } },
      }),
      { Environment: { Variables: { USER_POOL_ID: '/a/b', testtesttess: 'testtesttess' } } },
      schema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'Environment.Variables.testtesttess',
      nested: true,
      freeFormKey: true,
    });
  });

  it('a nested key NOT under a free-form map is plain nested (no freeFormKey)', () => {
    const schema: SchemaInfo = { ...emptySchema, freeFormMapPaths: ['Environment.Variables'] };
    const out = classifyResource(
      res('AWS::X::Y', { Conf: { Level: 'INFO' } }),
      { Conf: { Level: 'INFO', Destination: 's3' } },
      schema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'Conf.Destination', nested: true });
    expect(out[0]!.freeFormKey).toBeUndefined();
  });

  it('a free-form map key NESTED UNDER AN ARRAY ELEMENT (ECS DockerLabels) is flagged freeFormKey', () => {
    // The `*`-segment free-form map path aligns with the live `[id]`->`*`-normalized path
    // via startsWith, so a container's out-of-band DockerLabels key is surfaced too.
    const schema: SchemaInfo = {
      ...emptySchema,
      freeFormMapPaths: ['ContainerDefinitions.*.DockerLabels'],
    };
    const out = classifyResource(
      res('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [{ Name: 'app', DockerLabels: { team: 'a' } }],
      }),
      { ContainerDefinitions: [{ Name: 'app', DockerLabels: { team: 'a', rogue: 'x' } }] },
      schema
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'ContainerDefinitions[app].DockerLabels.rogue',
      nested: true,
      freeFormKey: true,
    });
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
      // Carry every identity field the alignment might use — the generic IDENTITY_FIELDS
      // `Id`, plus the NESTED_ARRAY_IDENTITY overrides (Backup RuleName, Route53 Priority,
      // Secret Region, ApiGateway Stage HttpMethod) — all set to `x`, so the element aligns
      // to `[x]` whichever key the type uses.
      const id = { Id: 'x', RuleName: 'x', Priority: 'x', Region: 'x', HttpMethod: 'x' };
      return [{ [head!]: [{ ...id, ...d }] }, { [head!]: [{ ...id, ...l }] }];
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
// RDS parameter-group Parameters map: MySQL boolean system variables accept ON/OFF, 1/0,
// TRUE/FALSE interchangeably; RDS canonicalizes a declared "ON"/"OFF" to "1"/"0" on read, so a
// case that declares "ON" false-flags declared drift against the live "1". Observed live on
// my-app-Rds.
// An Aurora DBInstance's live model echoes its parent DBCluster's cluster-level config
// (encryption, engine version, backup, security groups, subnet group, …) — undeclared on the
// instance, mirroring the cluster (which cdkrd classifies independently). classify drops the
// echo via opts.clusterEchoModel, equality-gated so an instance value that DIVERGES stays.
describe('Aurora DBInstance cluster-echo strip (CLUSTER_ECHO_CHILD)', () => {
  const bareEcho: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const inst = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'Writer',
    resourceType: 'AWS::RDS::DBInstance',
    physicalId: 'inst-1',
    declared,
  });
  const clusterEchoModel = {
    'inst-1': {
      StorageEncrypted: true,
      EngineVersion: '8.0.mysql_aurora.3.08.0',
      KmsKeyId: 'arn:aws:kms:ap-northeast-1:1:key/abc',
      BackupRetentionPeriod: 14,
      VpcSecurityGroupIds: ['sg-1'],
      PreferredMaintenanceWindow: 'tue:14:55-tue:15:25',
    },
  };

  it('drops undeclared instance props that ECHO the parent cluster (same key + value)', () => {
    const t = tiers(
      classifyResource(
        inst({ DBClusterIdentifier: 'c1' }),
        {
          StorageEncrypted: true,
          EngineVersion: '8.0.mysql_aurora.3.08.0',
          KmsKeyId: 'arn:aws:kms:ap-northeast-1:1:key/abc',
          BackupRetentionPeriod: 14,
        },
        bareEcho,
        { clusterEchoModel }
      )
    );
    expect(t.undeclared).toEqual([]);
  });

  it('drops VPCSecurityGroups via the VpcSecurityGroupIds alias', () => {
    const t = tiers(
      classifyResource(
        inst({ DBClusterIdentifier: 'c1' }),
        { VPCSecurityGroups: ['sg-1'] },
        bareEcho,
        { clusterEchoModel }
      )
    );
    expect(t.undeclared).toEqual([]);
  });

  it('KEEPS an instance value that DIVERGES from the cluster (echo strip is equality-gated)', () => {
    // EngineVersion echoes the cluster; an instance value that DIFFERS must surface (it is not
    // an echo). Uses a non-value-independent prop so the echo-strip gate is what is tested.
    const t = tiers(
      classifyResource(
        inst({ DBClusterIdentifier: 'c1' }),
        { EngineVersion: '8.0.mysql_aurora.3.09.0' },
        bareEcho,
        { clusterEchoModel }
      )
    );
    expect(t.undeclared).toEqual(['EngineVersion']);
  });

  it('KEEPS an instance-only property the cluster does not carry (equality-gated)', () => {
    const t = tiers(
      classifyResource(inst({ DBClusterIdentifier: 'c1' }), { Iops: 3000 }, bareEcho, {
        clusterEchoModel,
      })
    );
    expect(t.undeclared).toEqual(['Iops']);
  });

  it('with NO cluster echo model, the echoes surface (unchanged behavior — fail-open)', () => {
    const t = tiers(
      classifyResource(inst({ DBClusterIdentifier: 'c1' }), { StorageEncrypted: true }, bareEcho)
    );
    expect(t.undeclared).toEqual(['StorageEncrypted']);
  });

  it('a DECLARED instance property is compared normally, never echo-stripped', () => {
    // declared StorageEncrypted:false but live true (== cluster) — a real declared drift the
    // echo strip must NOT swallow.
    const t = tiers(
      classifyResource(
        inst({ DBClusterIdentifier: 'c1', StorageEncrypted: false }),
        { StorageEncrypted: true },
        bareEcho,
        { clusterEchoModel }
      )
    );
    expect(t.declared).toEqual(['StorageEncrypted']);
  });
});

describe('RDS parameter-group boolean tokens (ON≡1, OFF≡0)', () => {
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
      {
        logicalId: 'R',
        resourceType: 'AWS::RDS::DBClusterParameterGroup',
        physicalId: 'p',
        declared,
      },
      live,
      bare
    )
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  it('declared "ON" vs live "1" (and "OFF" vs "0") is NOT drift', () => {
    expect(
      declaredPaths(
        { Parameters: { slow_query_log: 'ON', general_log: 'OFF' } },
        { Parameters: { slow_query_log: '1', general_log: '0' } }
      )
    ).toEqual([]);
  });

  it('a genuine flip (declared "ON" vs live "0") STILL surfaces as drift', () => {
    expect(
      declaredPaths(
        { Parameters: { slow_query_log: 'ON' } },
        { Parameters: { slow_query_log: '0' } }
      )
    ).toEqual(['Parameters.slow_query_log']);
  });

  it('a non-boolean param ("2" vs "1") still surfaces — the fold cannot mis-fire', () => {
    expect(
      declaredPaths(
        { Parameters: { innodb_flush_log_at_trx_commit: '2' } },
        { Parameters: { innodb_flush_log_at_trx_commit: '1' } }
      )
    ).toEqual(['Parameters.innodb_flush_log_at_trx_commit']);
  });

  it('the fold is gated to RDS param-group types — the same map shape elsewhere stays strict', () => {
    const paths = classifyResource(
      {
        logicalId: 'R',
        resourceType: 'AWS::Other::Thing',
        physicalId: 'p',
        declared: { Parameters: { flag: 'ON' } },
      },
      { Parameters: { flag: '1' } },
      bare
    )
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);
    expect(paths).toEqual(['Parameters.flag']);
  });
});

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

  // Live-observed FP (docdb-version-fp fixture): DocumentDB accepts a partial
  // EngineVersion "5.0" and reads back the concrete "5.0.0".
  it('DocDB DBCluster EngineVersion "5.0" resolved to live "5.0.0" is NOT declared drift', () => {
    expect(
      declaredPaths('AWS::DocDB::DBCluster', { EngineVersion: '5.0' }, { EngineVersion: '5.0.0' })
    ).toEqual([]);
    // a genuine version change still differs
    expect(
      declaredPaths('AWS::DocDB::DBCluster', { EngineVersion: '4.0' }, { EngineVersion: '5.0.0' })
    ).toEqual(['EngineVersion']);
  });

  // PROACTIVE guard (corpus-proven latent trap): Amazon MQ resolves a partial EngineVersion
  // "5.18" to the concrete "5.18.7". Today EngineVersion is writeOnly (a readGap, never in the
  // live model), so the fold is inert; this pins that IF a future SDK_SUPPLEMENTS reader ever
  // projects the concrete EngineVersion back, the partial->concrete is folded, not false-drift.
  it('AmazonMQ Broker EngineVersion "5.18" resolved to live "5.18.7" is NOT declared drift', () => {
    expect(
      declaredPaths('AWS::AmazonMQ::Broker', { EngineVersion: '5.18' }, { EngineVersion: '5.18.7' })
    ).toEqual([]);
    // a genuine engine-version change still differs
    expect(
      declaredPaths('AWS::AmazonMQ::Broker', { EngineVersion: '5.17' }, { EngineVersion: '5.18.7' })
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

// Engine-derived RDS defaults (ENGINE_DEFAULTS + DEFAULT_MANAGED_NAME_PATHS + the
// CACertificateIdentifier constant): values the user never set that AWS fills in from the
// engine family, folded to atDefault so a clean CDK Aurora first run is not flooded with
// potential-drift noise. Observed live on my-app-Rds / my-app-UserStore-DB.
// AWS-ASSIGNED RDS values a user never declared: the KMS key, AZ placement, and randomly-
// assigned maintenance/backup windows AWS picks at creation. Undeclared → AWS's choice, not
// user intent → folded value-independent (atDefault). A DECLARED value is user intent →
// compared in the declared loop (detected). Observed live on my-app-Rds / DbUsers-DB.
describe('RDS AWS-assigned values fold value-independent (KmsKeyId/AZ/windows)', () => {
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
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    tiers(
      classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
    );

  it('DBCluster undeclared KmsKeyId/AZs/windows fold to atDefault (not undeclared drift)', () => {
    const r = t(
      'AWS::RDS::DBCluster',
      {},
      {
        KmsKeyId: 'arn:aws:kms:ap-northeast-1:1:key/abc',
        AvailabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
        PreferredMaintenanceWindow: 'tue:14:55-tue:15:25',
        PreferredBackupWindow: '20:30-21:00',
      }
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toEqual(
      expect.arrayContaining([
        'KmsKeyId',
        'AvailabilityZones',
        'PreferredMaintenanceWindow',
        'PreferredBackupWindow',
      ])
    );
  });

  it('DBInstance undeclared AZ/window fold', () => {
    const r = t(
      'AWS::RDS::DBInstance',
      {},
      { AvailabilityZone: 'ap-northeast-1d', PreferredMaintenanceWindow: 'fri:15:16-fri:15:46' }
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toEqual(
      expect.arrayContaining(['AvailabilityZone', 'PreferredMaintenanceWindow'])
    );
  });

  it('a DECLARED window is user intent — compared in the declared loop, still detected', () => {
    const r = t(
      'AWS::RDS::DBCluster',
      { PreferredMaintenanceWindow: 'mon:00:00-mon:00:30' },
      { PreferredMaintenanceWindow: 'tue:14:55-tue:15:25' }
    );
    expect(r.declared).toEqual(['PreferredMaintenanceWindow']);
    expect(r.atDefault).not.toContain('PreferredMaintenanceWindow');
  });

  it('EngineLifecycleSupport folds value-independent — BOTH the enabled and disabled forms', () => {
    // The value is set by the resource's ORIGINAL creation era: a pre-RDS-Extended-Support
    // lineage reads "…support-disabled", a newer one the "…support" default. A RESTORE resets
    // the readable ClusterCreateTime to the restore date, so an untouched, undeclared cluster
    // can read "-disabled" under a recent timestamp (live-verified) — the live model exposes no
    // signal that reconstructs it. Both must fold; surfacing an untouched restored cluster's
    // "-disabled" would be a false positive.
    for (const v of [
      'open-source-rds-extended-support',
      'open-source-rds-extended-support-disabled',
    ]) {
      expect(t('AWS::RDS::DBCluster', {}, { EngineLifecycleSupport: v }).atDefault).toContain(
        'EngineLifecycleSupport'
      );
      expect(t('AWS::RDS::DBInstance', {}, { EngineLifecycleSupport: v }).atDefault).toContain(
        'EngineLifecycleSupport'
      );
    }
  });

  it('a DECLARED EngineLifecycleSupport is user intent — still compared/detected', () => {
    const r = t(
      'AWS::RDS::DBCluster',
      { EngineLifecycleSupport: 'open-source-rds-extended-support' },
      { EngineLifecycleSupport: 'open-source-rds-extended-support-disabled' }
    );
    expect(r.declared).toEqual(['EngineLifecycleSupport']);
    expect(r.atDefault).not.toContain('EngineLifecycleSupport');
  });

  it('the value-independent fold is gated per-type — another type stays undeclared', () => {
    const r = t('AWS::Other::Thing', {}, { KmsKeyId: 'arn:aws:kms:x:1:key/abc' });
    expect(r.undeclared).toContain('KmsKeyId');
  });

  // The RDS-family + cache engines mirror the RDS window precedent: an AWS-assigned
  // maintenance / backup / snapshot window read back on an undeclared property is AWS's
  // random choice, not user intent, so it folds value-independent (found by the offline
  // first-run-noise sweep across the DocDB/Neptune/ElastiCache/MemoryDB/Redshift corpus).
  it('DocDB / Neptune / ElastiCache / MemoryDB / Redshift AWS-assigned windows fold value-independent', () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      [
        'AWS::DocDB::DBCluster',
        { PreferredMaintenanceWindow: 'thu:04:03-thu:04:33', PreferredBackupWindow: '03:10-03:40' },
        ['PreferredMaintenanceWindow', 'PreferredBackupWindow'],
      ],
      [
        'AWS::DocDB::DBInstance',
        { PreferredMaintenanceWindow: 'fri:03:49-fri:04:19' },
        ['PreferredMaintenanceWindow'],
      ],
      [
        'AWS::Neptune::DBCluster',
        { PreferredMaintenanceWindow: 'sat:14:01-sat:14:31', PreferredBackupWindow: '21:15-21:45' },
        ['PreferredMaintenanceWindow', 'PreferredBackupWindow'],
      ],
      [
        'AWS::Neptune::DBInstance',
        { PreferredMaintenanceWindow: 'tue:20:02-tue:20:32' },
        ['PreferredMaintenanceWindow'],
      ],
      [
        'AWS::ElastiCache::CacheCluster',
        { PreferredMaintenanceWindow: 'sat:03:00-sat:04:00', SnapshotWindow: '07:30-08:30' },
        ['PreferredMaintenanceWindow', 'SnapshotWindow'],
      ],
      [
        'AWS::ElastiCache::ReplicationGroup',
        { PreferredMaintenanceWindow: 'mon:05:00-mon:06:00', SnapshotWindow: '05:00-06:00' },
        ['PreferredMaintenanceWindow', 'SnapshotWindow'],
      ],
      ['AWS::ElastiCache::ServerlessCache', { DailySnapshotTime: '05:30' }, ['DailySnapshotTime']],
      [
        'AWS::MemoryDB::Cluster',
        { MaintenanceWindow: 'fri:07:00-fri:08:00', SnapshotWindow: '09:30-10:30' },
        ['MaintenanceWindow', 'SnapshotWindow'],
      ],
      [
        'AWS::Redshift::Cluster',
        { PreferredMaintenanceWindow: 'sat:04:30-sat:05:00' },
        ['PreferredMaintenanceWindow'],
      ],
      // an AWS-assigned window returned as an OBJECT (AmazonMQ) folds whole, value-independent
      [
        'AWS::AmazonMQ::Broker',
        {
          MaintenanceWindowStartTime: { DayOfWeek: 'FRIDAY', TimeOfDay: '20:00', TimeZone: 'UTC' },
        },
        ['MaintenanceWindowStartTime'],
      ],
    ];
    for (const [type, live, props] of cases) {
      const r = t(type, {}, live);
      expect(r.undeclared).toEqual([]);
      expect(r.atDefault).toEqual(expect.arrayContaining(props));
    }
  });

  it('a DECLARED cache/DB window is user intent — compared in the declared loop, still detected', () => {
    const r = t(
      'AWS::ElastiCache::CacheCluster',
      { PreferredMaintenanceWindow: 'mon:00:00-mon:01:00' },
      { PreferredMaintenanceWindow: 'sat:03:00-sat:04:00' }
    );
    expect(r.declared).toEqual(['PreferredMaintenanceWindow']);
    expect(r.atDefault).not.toContain('PreferredMaintenanceWindow');
  });
});

// Core VPC-networking types read back an AWS-ASSIGNED, CREATE-ONLY placement identifier on
// every first run (the primary private IP AWS allocates from the subnet, the mount-target IP,
// the EIP border group, an endpoint's / peering's region). Each is AWS's per-resource choice,
// never user intent when undeclared, and — being create-only — can never move out of band, so
// it folds value-independent. A user who pins a value DECLARES it (compared in the declared
// loop). Found by the offline first-run-noise sweep over the VPC-common corpus cases.
describe('VPC-networking AWS-assigned create-only identifiers fold value-independent', () => {
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
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    tiers(
      classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
    );

  it('undeclared assigned identifiers fold to atDefault (not undeclared drift)', () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      ['AWS::EC2::Instance', { PrivateIpAddress: '10.0.0.216' }, ['PrivateIpAddress']],
      ['AWS::EC2::NetworkInterface', { PrivateIpAddress: '10.0.0.221' }, ['PrivateIpAddress']],
      // NatGateway also reads back the VPC id AWS derives from the declared SubnetId.
      [
        'AWS::EC2::NatGateway',
        { PrivateIpAddress: '10.0.0.62', VpcId: 'vpc-04afc4de702561220' },
        ['PrivateIpAddress', 'VpcId'],
      ],
      ['AWS::EFS::MountTarget', { IpAddress: '10.0.88.116' }, ['IpAddress']],
      ['AWS::EC2::EIP', { NetworkBorderGroup: 'us-east-1' }, ['NetworkBorderGroup']],
      ['AWS::EC2::VPCEndpoint', { ServiceRegion: 'us-east-1' }, ['ServiceRegion']],
      ['AWS::EC2::VPCPeeringConnection', { PeerRegion: 'us-east-1' }, ['PeerRegion']],
      ['AWS::Neptune::DBInstance', { AvailabilityZone: 'ap-northeast-1c' }, ['AvailabilityZone']],
    ];
    for (const [type, live, props] of cases) {
      const r = t(type, {}, live);
      expect(r.undeclared).toEqual([]);
      expect(r.atDefault).toEqual(expect.arrayContaining(props));
    }
  });

  it('a DECLARED PrivateIpAddress is user intent — compared in the declared loop, still detected', () => {
    const r = t(
      'AWS::EC2::Instance',
      { PrivateIpAddress: '10.0.0.5' },
      { PrivateIpAddress: '10.0.0.216' }
    );
    expect(r.declared).toEqual(['PrivateIpAddress']);
    expect(r.atDefault).not.toContain('PrivateIpAddress');
  });

  it('the fold is gated per-type — a different type keeps PrivateIpAddress undeclared', () => {
    const r = t('AWS::Other::Thing', {}, { PrivateIpAddress: '10.0.0.9' });
    expect(r.undeclared).toContain('PrivateIpAddress');
  });

  // The EIP PublicIpv4Pool "amazon" default and the VPCEndpoint default full-access
  // PolicyDocument / service-defined DnsOptions are equality-gated KNOWN_DEFAULTS — they fold
  // the AWS default but SURFACE a value changed out of band (the FN half proven live: a
  // tightened endpoint policy re-surfaces). Live-observed on a fresh vpc-common deploy.
  const DEFAULT_ENDPOINT_POLICY = {
    Version: '2008-10-17',
    Statement: [{ Effect: 'Allow', Principal: '*', Action: ['*'], Resource: ['*'] }],
  };
  const DEFAULT_DNS_OPTIONS = {
    PrivateDnsOnlyForInboundResolverEndpoint: 'NotSpecified',
    PrivateDnsSpecifiedDomains: ['*'],
    DnsRecordIpType: 'service-defined',
    PrivateDnsPreference: 'VERIFIED_DOMAINS_ONLY',
  };

  it('EIP PublicIpv4Pool "amazon" + VPCEndpoint default policy fold (equality-gated)', () => {
    expect(t('AWS::EC2::EIP', {}, { PublicIpv4Pool: 'amazon' }).atDefault).toContain(
      'PublicIpv4Pool'
    );
    const ep = t(
      'AWS::EC2::VPCEndpoint',
      {},
      { PolicyDocument: DEFAULT_ENDPOINT_POLICY, DnsOptions: DEFAULT_DNS_OPTIONS }
    );
    expect(ep.undeclared).toEqual([]);
    expect(ep.atDefault).toEqual(expect.arrayContaining(['PolicyDocument', 'DnsOptions']));
  });

  it('VPCEndpoint DnsOptions folds value-independent — both the gateway and interface defaults', () => {
    // DnsRecordIpType is "service-defined" for a gateway endpoint, "ipv4" for an interface one;
    // both AWS defaults fold whole (a user who configures DNS DECLARES DnsOptions).
    for (const ipType of ['service-defined', 'ipv4', 'dualstack']) {
      const r = t(
        'AWS::EC2::VPCEndpoint',
        {},
        { DnsOptions: { ...DEFAULT_DNS_OPTIONS, DnsRecordIpType: ipType } }
      );
      expect(r.atDefault).toContain('DnsOptions');
      expect(r.undeclared).not.toContain('DnsOptions');
    }
  });

  it('a value changed away from the default still surfaces (equality-gate preserves detection)', () => {
    // a BYOIP pool is not "amazon"
    expect(t('AWS::EC2::EIP', {}, { PublicIpv4Pool: 'ipv4pool-ec2-abc' }).undeclared).toContain(
      'PublicIpv4Pool'
    );
    // a tightened endpoint policy no longer matches the full-access default
    const tightened = {
      Version: '2008-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['*'] }],
    };
    expect(t('AWS::EC2::VPCEndpoint', {}, { PolicyDocument: tightened }).undeclared).toContain(
      'PolicyDocument'
    );
  });
});

// Second offline noise-sweep batch: AWS-managed parameter-group names, Redshift constant
// defaults, and OpenSearch domain defaults — all undeclared AWS-assigned values a first run
// would otherwise flag as [Potential Drift].
describe('managed param-group names + Redshift/OpenSearch defaults fold', () => {
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
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    tiers(
      classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
    );

  it('the AWS-managed default.* parameter-group name folds (regex), a custom one still surfaces', () => {
    const cases: [string, string, string][] = [
      ['AWS::ElastiCache::CacheCluster', 'CacheParameterGroupName', 'default.redis7'],
      ['AWS::DocDB::DBCluster', 'DBClusterParameterGroupName', 'default.docdb5.0'],
      ['AWS::Neptune::DBCluster', 'DBClusterParameterGroupName', 'default.neptune1.3'],
      ['AWS::Neptune::DBInstance', 'DBParameterGroupName', 'default.neptune1.3'],
      ['AWS::Redshift::Cluster', 'ClusterParameterGroupName', 'default.redshift-2.0'],
      ['AWS::MemoryDB::Cluster', 'ParameterGroupName', 'default.memorydb-redis7'],
    ];
    for (const [type, prop, val] of cases) {
      expect(t(type, {}, { [prop]: val }).atDefault).toContain(prop);
      // a custom (non-default.*) group name is real undeclared inventory
      expect(t(type, {}, { [prop]: 'my-custom-group' }).undeclared).toContain(prop);
    }
  });

  it('Redshift constant defaults fold; security/topology values stay undeclared', () => {
    const r = t(
      'AWS::Redshift::Cluster',
      {},
      {
        Port: 5439,
        AutomatedSnapshotRetentionPeriod: 1,
        ManualSnapshotRetentionPeriod: -1,
        AllowVersionUpgrade: true,
        AquaConfigurationStatus: 'auto',
        MaintenanceTrackName: 'current',
        KmsKeyId: 'AWS_OWNED_KMS_KEY',
        AvailabilityZone: 'us-east-1a',
        Encrypted: true,
        NumberOfNodes: 1,
      }
    );
    expect(r.atDefault).toEqual(
      expect.arrayContaining([
        'Port',
        'AutomatedSnapshotRetentionPeriod',
        'ManualSnapshotRetentionPeriod',
        'AllowVersionUpgrade',
        'AquaConfigurationStatus',
        'MaintenanceTrackName',
        'KmsKeyId',
        'AvailabilityZone',
        'NumberOfNodes', // single-node default, KNOWN_DEFAULTS 1
      ])
    );
    // Encrypted stays undeclared WITHOUT a declared NodeType: the RA3 always-encrypted conditional
    // needs the NodeType discriminator, so absent it a true is treated as a real (DC2-style) enable
    // and surfaces. (A declared RA3 NodeType folds it — see the clean-deploy invariant describe.)
    expect(r.undeclared).toContain('Encrypted');
    // a non-default port surfaces (equality-gated)
    expect(t('AWS::Redshift::Cluster', {}, { Port: 5555 }).undeclared).toContain('Port');
  });

  it('OpenSearch domain defaults fold; the AWS-assigned off-peak window folds value-independent', () => {
    const r = t(
      'AWS::OpenSearchService::Domain',
      {},
      {
        SnapshotOptions: { AutomatedSnapshotStartHour: 0 },
        AdvancedOptions: {
          override_main_response_version: 'false',
          'rest.action.multi.allow_explicit_index': 'true',
        },
        OffPeakWindowOptions: {
          OffPeakWindow: { WindowStartTime: { Hours: 2, Minutes: 0 } },
          Enabled: true,
        },
      }
    );
    expect(r.atDefault).toEqual(
      expect.arrayContaining(['SnapshotOptions', 'AdvancedOptions', 'OffPeakWindowOptions'])
    );
    // a non-default snapshot hour surfaces (equality-gated)
    expect(
      t(
        'AWS::OpenSearchService::Domain',
        {},
        { SnapshotOptions: { AutomatedSnapshotStartHour: 3 } }
      ).undeclared
    ).toContain('SnapshotOptions');
    // a DECLARED off-peak window is user intent — compared (descended), NOT value-independent
    // folded; a divergent start hour surfaces as declared drift on the nested path.
    const declared = t(
      'AWS::OpenSearchService::Domain',
      { OffPeakWindowOptions: { OffPeakWindow: { WindowStartTime: { Hours: 5, Minutes: 0 } } } },
      {
        OffPeakWindowOptions: {
          OffPeakWindow: { WindowStartTime: { Hours: 2, Minutes: 0 } },
          Enabled: true,
        },
      }
    );
    expect(declared.declared.some((p) => p.startsWith('OffPeakWindowOptions'))).toBe(true);
    expect(declared.atDefault).not.toContain('OffPeakWindowOptions');
  });
});

// AWS DataSync Task: a task whose declared Options block leaves the transfer knobs unset reads
// them all back at the documented service defaults. The round-B entry (#496) covered most but
// missed Options.TaskQueueing (ENABLED) + Options.PreserveDeletedFiles (PRESERVE); both surfaced
// as potential drift on a fresh datasync-rich deploy (hunt 2026-07-07). Equality-gated, so a
// changed value still surfaces.
describe('DataSync Task Options first-run defaults fold', () => {
  const bareD: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const liveOptions = {
    Atime: 'BEST_EFFORT',
    Mtime: 'PRESERVE',
    Uid: 'NONE',
    Gid: 'NONE',
    PreserveDevices: 'NONE',
    PosixPermissions: 'NONE',
    ObjectTags: 'PRESERVE',
    BytesPerSecond: -1,
    SecurityDescriptorCopyFlags: 'NONE',
    TaskQueueing: 'ENABLED',
    PreserveDeletedFiles: 'PRESERVE',
  };

  it('a task with a partial declared Options block folds every AWS-default sub-key (incl. TaskQueueing + PreserveDeletedFiles)', () => {
    const r = tiers(
      classifyResource(
        {
          logicalId: 'Task',
          resourceType: 'AWS::DataSync::Task',
          physicalId: 'arn:aws:datasync:us-east-1:1:task/task-0',
          // a real task declares a couple of Options and leaves the rest to AWS
          declared: { Options: { VerifyMode: 'ONLY_FILES_TRANSFERRED', LogLevel: 'OFF' } },
        },
        { Options: { VerifyMode: 'ONLY_FILES_TRANSFERRED', LogLevel: 'OFF', ...liveOptions } },
        bareD
      )
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toEqual(
      expect.arrayContaining(['Options.TaskQueueing', 'Options.PreserveDeletedFiles'])
    );
  });

  it('equality-gated: a task that disables queueing / removes deleted files surfaces (detection preserved)', () => {
    const r = tiers(
      classifyResource(
        {
          logicalId: 'Task',
          resourceType: 'AWS::DataSync::Task',
          physicalId: 'arn:aws:datasync:us-east-1:1:task/task-0',
          declared: { Options: { VerifyMode: 'ONLY_FILES_TRANSFERRED' } },
        },
        {
          Options: {
            VerifyMode: 'ONLY_FILES_TRANSFERRED',
            TaskQueueing: 'DISABLED',
            PreserveDeletedFiles: 'REMOVE',
          },
        },
        bareD
      )
    );
    expect(r.undeclared).toEqual(
      expect.arrayContaining(['Options.TaskQueueing', 'Options.PreserveDeletedFiles'])
    );
  });
});

// Amazon Managed Grafana: a workspace that declares no GrafanaVersion reads back the concrete
// GA version AWS provisioned at creation ("10.4" today) — an AWS-assigned value that moves over
// time, so it folds value-independent (undeclared only). Live-verified on a fresh grafana-rich
// deploy (hunt 2026-07-07).
describe('Grafana Workspace GrafanaVersion fold (AWS-assigned version)', () => {
  const bareG: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const decl = {
    Name: 'cdkrd-grafana-rich',
    AccountAccessType: 'CURRENT_ACCOUNT',
    AuthenticationProviders: ['SAML'],
    PermissionType: 'SERVICE_MANAGED',
  };

  it('an undeclared AWS-assigned GrafanaVersion folds to atDefault (zero potential drift)', () => {
    const r = tiers(
      classifyResource(
        {
          logicalId: 'Workspace',
          resourceType: 'AWS::Grafana::Workspace',
          physicalId: 'g-f76beca787',
          declared: decl,
        },
        { ...decl, GrafanaVersion: '10.4' },
        bareG
      )
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toContain('GrafanaVersion');
  });

  it('value-independent: a future default version also folds when undeclared', () => {
    const r = tiers(
      classifyResource(
        {
          logicalId: 'Workspace',
          resourceType: 'AWS::Grafana::Workspace',
          physicalId: 'g-abc',
          declared: decl,
        },
        { ...decl, GrafanaVersion: '11.2' },
        bareG
      )
    );
    expect(r.atDefault).toContain('GrafanaVersion');
  });

  it('a DECLARED GrafanaVersion is still compared (out-of-band upgrade surfaces as declared drift)', () => {
    const declared = { ...decl, GrafanaVersion: '9.4' };
    const r = tiers(
      classifyResource(
        {
          logicalId: 'Workspace',
          resourceType: 'AWS::Grafana::Workspace',
          physicalId: 'g-abc',
          declared,
        },
        { ...declared, GrafanaVersion: '10.4' },
        bareG
      )
    );
    expect(r.declared).toContain('GrafanaVersion');
    expect(r.atDefault).not.toContain('GrafanaVersion');
  });
});

// The clean-deploy -> zero-potential-drift invariant, live-verified on a fresh redshift-rich
// (RA3 single-node) + opensearch-rich deploy: EVERY undeclared value AWS returned must fold.
describe('Redshift/OpenSearch clean-deploy invariant (all AWS-initial values fold)', () => {
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
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    tiers(
      classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
    );

  it('a fresh RA3 single-node Redshift cluster has ZERO undeclared (every AWS-initial value folds)', () => {
    // exactly what a fresh redshift-rich deploy returns undeclared (live-verified)
    const r = t(
      'AWS::Redshift::Cluster',
      { NodeType: 'ra3.large', ClusterType: 'single-node' },
      {
        AvailabilityZoneRelocationStatus: 'enabled', // RA3 conditional
        Encrypted: true, // RA3 always encrypted (conditional)
        NumberOfNodes: 1, // single-node KNOWN_DEFAULT
        ClusterVersion: '1.0', // AWS-assigned version, value-independent
      }
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toEqual(
      expect.arrayContaining([
        'AvailabilityZoneRelocationStatus',
        'Encrypted',
        'NumberOfNodes',
        'ClusterVersion',
      ])
    );
  });

  it('the RA3 conditional is NodeType-gated — a DC2 cluster does NOT fold Encrypted=true, and a resize surfaces', () => {
    // DC2 (not always-encrypted): an undeclared Encrypted=true is a REAL enable → must surface
    const dc2 = t('AWS::Redshift::Cluster', { NodeType: 'dc2.large' }, { Encrypted: true });
    expect(dc2.undeclared).toContain('Encrypted');
    // detection preserved on RA3 too: NumberOfNodes off the single-node default surfaces
    const resized = t('AWS::Redshift::Cluster', { NodeType: 'ra3.large' }, { NumberOfNodes: 4 });
    expect(resized.undeclared).toContain('NumberOfNodes');
  });

  it('a fresh OpenSearch domain folds the AWS-assigned deployment strategy + encryption key', () => {
    // mirrors the real live shape: EncryptionAtRestOptions is partially declared ({Enabled:true}),
    // so classify descends and the AWS-added KmsKeyId sub-key folds value-independent (nested).
    const r = t(
      'AWS::OpenSearchService::Domain',
      { EncryptionAtRestOptions: { Enabled: true } },
      {
        DeploymentStrategyOptions: { DeploymentStrategy: 'CapacityOptimized' },
        EncryptionAtRestOptions: {
          KmsKeyId: 'db99576a-7bcf-4386-a93e-0334efbed006',
          Enabled: true,
        },
      }
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toContain('DeploymentStrategyOptions');
    // the nested AWS-assigned key folds value-independent (generated tier), whatever its GUID
    expect(r.generated).toContain('EncryptionAtRestOptions.KmsKeyId');
    // a non-default deployment strategy surfaces (equality-gated)
    expect(
      t(
        'AWS::OpenSearchService::Domain',
        {},
        { DeploymentStrategyOptions: { DeploymentStrategy: 'Custom' } }
      ).undeclared
    ).toContain('DeploymentStrategyOptions');
  });
});

describe('RDS engine-derived defaults fold to atDefault', () => {
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
  const cls = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    tiers(
      classifyResource({ logicalId: 'R', resourceType, physicalId: 'p', declared }, live, bare)
    );

  it('DBInstance StorageType "aurora" (Engine aurora-mysql) folds atDefault', () => {
    const t = cls(
      'AWS::RDS::DBInstance',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', StorageType: 'aurora' }
    );
    expect(t.atDefault).toContain('StorageType');
    expect(t.undeclared).not.toContain('StorageType');
  });

  it('DBInstance echoes Port/AllocatedStorage as STRINGS — typed<->string coercion folds them', () => {
    const t = cls(
      'AWS::RDS::DBInstance',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', Port: '3306', AllocatedStorage: '1' }
    );
    expect(t.atDefault).toEqual(expect.arrayContaining(['Port', 'AllocatedStorage']));
    expect(t.undeclared).toEqual([]);
  });

  it('DBCluster carries Port/AllocatedStorage as NUMBERS — both fold', () => {
    const t = cls(
      'AWS::RDS::DBCluster',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', Port: 3306, AllocatedStorage: 1, StorageType: 'aurora' }
    );
    expect(t.atDefault).toEqual(
      expect.arrayContaining(['Port', 'AllocatedStorage', 'StorageType'])
    );
    expect(t.undeclared).toEqual([]);
  });

  it('LicenseModel folds per engine family (mysql -> general-public-license, postgres -> postgresql-license)', () => {
    expect(
      cls(
        'AWS::RDS::DBInstance',
        { Engine: 'aurora-mysql' },
        { Engine: 'aurora-mysql', LicenseModel: 'general-public-license' }
      ).atDefault
    ).toContain('LicenseModel');
    expect(
      cls(
        'AWS::RDS::DBInstance',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql', LicenseModel: 'postgresql-license' }
      ).atDefault
    ).toContain('LicenseModel');
  });

  it('Postgres default Port 5432 folds; a MySQL 3306 on a Postgres engine still surfaces (equality-gated)', () => {
    expect(
      cls(
        'AWS::RDS::DBInstance',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql', Port: '5432' }
      ).atDefault
    ).toContain('Port');
    expect(
      cls('AWS::RDS::DBInstance', { Engine: 'postgres' }, { Engine: 'postgres', Port: '3306' })
        .undeclared
    ).toContain('Port');
  });

  it('non-Aurora StorageType (gp2 on plain MySQL) does NOT fold — only the aurora constant does', () => {
    const t = cls(
      'AWS::RDS::DBInstance',
      { Engine: 'mysql' },
      { Engine: 'mysql', StorageType: 'gp2' }
    );
    expect(t.undeclared).toContain('StorageType');
    expect(t.atDefault).not.toContain('StorageType');
  });

  it('default parameter/option groups fold by the reserved default. / default: prefix', () => {
    const t = cls(
      'AWS::RDS::DBInstance',
      { Engine: 'aurora-mysql' },
      {
        Engine: 'aurora-mysql',
        DBParameterGroupName: 'default.aurora-mysql8.0',
        OptionGroupName: 'default:aurora-mysql-8-0',
      }
    );
    expect(t.atDefault).toEqual(
      expect.arrayContaining(['DBParameterGroupName', 'OptionGroupName'])
    );
    expect(t.undeclared).toEqual([]);
  });

  it('a CUSTOM parameter group (no default. prefix) still surfaces as undeclared', () => {
    const t = cls(
      'AWS::RDS::DBInstance',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', DBParameterGroupName: 'mystack-instancepg-abc123' }
    );
    expect(t.undeclared).toContain('DBParameterGroupName');
    expect(t.atDefault).not.toContain('DBParameterGroupName');
  });

  it('CACertificateIdentifier default rds-ca-rsa2048-g1 folds (constant); a pinned CA surfaces', () => {
    expect(
      cls(
        'AWS::RDS::DBInstance',
        { Engine: 'aurora-mysql' },
        { Engine: 'aurora-mysql', CACertificateIdentifier: 'rds-ca-rsa2048-g1' }
      ).atDefault
    ).toContain('CACertificateIdentifier');
    expect(
      cls(
        'AWS::RDS::DBInstance',
        { Engine: 'aurora-mysql' },
        { Engine: 'aurora-mysql', CACertificateIdentifier: 'rds-ca-2019' }
      ).undeclared
    ).toContain('CACertificateIdentifier');
  });

  it('the engine fold is gated to RDS types — the same key on another type is undeclared', () => {
    const t = cls(
      'AWS::Other::Thing',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', StorageType: 'aurora' }
    );
    expect(t.undeclared).toContain('StorageType');
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
    // the always-present standard attributes are folded inventory, NEVER declared drift.
    // A live-only standard attribute at its canonical default shape folds to atDefault
    // (IDENTITY_KEYED_DEFAULT_ELEMENTS); the fixture's generic shape matches the default
    // for the plain String attrs (address/name/phone_number) but NOT for `sub` (immutable,
    // required) or `birthdate` (10-char constraint), which keep their generic test shape
    // and so stay foldable undeclared inventory here.
    const tierOf = (n: string) => findings.find((f) => f.nested && f.path === `Schema[${n}]`)?.tier;
    for (const n of ['phone_number', 'address', 'name']) expect(tierOf(n)).toBe('atDefault');
    for (const n of ['sub', 'birthdate']) expect(tierOf(n)).toBe('undeclared');
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

describe('Route53Resolver ResolverEndpoint IpAddresses identity-keyed subset (issue #467 --wait live-test)', () => {
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
  const endpoint = (declared: Record<string, unknown>) => ({
    logicalId: 'HuntOutboundEndpoint',
    resourceType: 'AWS::Route53Resolver::ResolverEndpoint',
    physicalId: 'rslvr-out-abc',
    declared,
  });
  // The template declares SubnetId only (AWS assigns the IP).
  const declaredA = { SubnetId: 'subnet-a' };
  const declaredB = { SubnetId: 'subnet-b' };
  // AWS enriches each live entry with the assigned Ip (+ IpId/Status) and returns them
  // in a NON-deterministic order (here: b before a, the reverse of the declared order).
  const liveA = { SubnetId: 'subnet-a', Ip: '10.0.0.53', IpId: 'rni-a', Status: 'ATTACHED' };
  const liveB = { SubnetId: 'subnet-b', Ip: '10.0.0.106', IpId: 'rni-b', Status: 'ATTACHED' };

  it('reordered + IP-enriched IpAddresses does NOT false-drift the SubnetId (the RSLVR-00405 FP)', () => {
    const findings = classifyResource(
      endpoint({ IpAddresses: [declaredA, declaredB] }),
      { IpAddresses: [liveB, liveA] }, // reversed order + assigned Ip/IpId
      bare
    );
    // no declared drift at all — the phantom SubnetId drift (that then failed to revert
    // with RSLVR-00405) is gone; the assigned Ip/IpId are an undeclared superset, not a
    // declared change, so aligning by SubnetId leaves the declared subset matching.
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
  });

  it('a declared subnet genuinely absent from live is still declared drift', () => {
    const declaredDrift = classifyResource(
      endpoint({ IpAddresses: [declaredA, declaredB] }),
      { IpAddresses: [liveA] }, // subnet-b endpoint IP removed out of band
      bare
    ).filter((f) => f.tier === 'declared');
    expect(declaredDrift).toHaveLength(1);
  });
});

describe('EC2 Instance Volumes identity-keyed subset (found by ec2-instance-sets)', () => {
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
    logicalId: 'Inst',
    resourceType: 'AWS::EC2::Instance',
    physicalId: 'i-0abc',
    declared,
  });
  // The template attaches two volumes, declared NON-sorted by Device (/dev/sdg first).
  const declaredVols = [
    { Device: '/dev/sdg', VolumeId: 'vol-aaaa' },
    { Device: '/dev/sdf', VolumeId: 'vol-bbbb' },
  ];
  // The live model adds the AMI ROOT volume (/dev/xvda) the template never declared and
  // interleaves it among the declared attachments (keys also reordered VolumeId-first).
  const liveVols = [
    { VolumeId: 'vol-aaaa', Device: '/dev/sdg' },
    { VolumeId: 'vol-root', Device: '/dev/xvda' },
    { VolumeId: 'vol-bbbb', Device: '/dev/sdf' },
  ];

  it('the extra live root volume does NOT false-drift the whole Volumes array', () => {
    const findings = classifyResource(inst({ Volumes: declaredVols }), { Volumes: liveVols }, bare);
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // the live-only root volume surfaces as nested undeclared inventory, keyed by Device
    const undeclared = findings.filter(
      (f) => f.tier === 'undeclared' && f.path === 'Volumes[/dev/xvda]'
    );
    expect(undeclared).toHaveLength(1);
  });

  it('a declared attachment detached out of band (Device removed from live) is declared drift', () => {
    const declaredDrift = classifyResource(
      inst({ Volumes: declaredVols }),
      {
        Volumes: [
          { VolumeId: 'vol-aaaa', Device: '/dev/sdg' },
          { VolumeId: 'vol-root', Device: '/dev/xvda' },
        ],
      }, // /dev/sdf gone
      bare
    ).filter((f) => f.tier === 'declared');
    expect(declaredDrift).toHaveLength(1);
  });

  it('a different volume attached at a declared Device is declared drift', () => {
    const declaredDrift = classifyResource(
      inst({ Volumes: declaredVols }),
      {
        Volumes: [
          { VolumeId: 'vol-aaaa', Device: '/dev/sdg' },
          { VolumeId: 'vol-CHANGED', Device: '/dev/sdf' },
        ],
      },
      bare
    ).filter((f) => f.tier === 'declared');
    expect(declaredDrift).toHaveLength(1);
    expect(declaredDrift[0]).toMatchObject({ desired: 'vol-bbbb', actual: 'vol-CHANGED' });
  });
});

describe('Cognito UserPoolUser UserAttributes identity-keyed subset (found by cognito-userpooluser-rich)', () => {
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
  const user = (declared: Record<string, unknown>) => ({
    logicalId: 'User',
    resourceType: 'AWS::Cognito::UserPoolUser',
    physicalId: 'us-east-1_pool|cdkrd-user',
    declared,
  });
  // Template declares only `email`; AWS injects the server-generated immutable `sub`.
  const declaredEmail = { Name: 'email', Value: 'cdkrd@example.com' };
  const liveEmail = { Value: 'cdkrd@example.com', Name: 'email' }; // key order differs
  const liveSub = { Value: '04c894d8-20e1-70ed-175e-9a01d11f7f45', Name: 'sub' };

  it('the AWS-injected sub attribute does NOT false-drift the whole UserAttributes array', () => {
    const findings = classifyResource(
      user({ UserAttributes: [declaredEmail] }),
      { UserAttributes: [liveEmail, liveSub] },
      bare
    );
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
    // sub surfaces as nested undeclared inventory, keyed by Name
    const undeclared = findings.filter(
      (f) => f.tier === 'undeclared' && f.path === 'UserAttributes[sub]'
    );
    expect(undeclared).toHaveLength(1);
  });

  it('an out-of-band change to the DECLARED email attribute is reported as declared drift', () => {
    const declaredDrift = classifyResource(
      user({ UserAttributes: [declaredEmail] }),
      { UserAttributes: [{ Name: 'email', Value: 'changed@example.com' }, liveSub] },
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

describe('NESTED_ARRAY_IDENTITY (ApiGateway Method IntegrationResponses keyed by StatusCode)', () => {
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
  const method = (integration: Record<string, unknown>): DesiredResource => ({
    logicalId: 'ApiOPTIONS',
    resourceType: 'AWS::ApiGateway::Method',
    physicalId: 'abc|9zav19|OPTIONS',
    declared: {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
      Integration: integration,
    },
  });

  it('descends IntegrationResponses by StatusCode and emits a live-only SelectionPattern / ContentHandling', () => {
    const declared = method({
      Type: 'MOCK',
      IntegrationResponses: [{ StatusCode: '204', ResponseTemplates: { 'application/json': 'x' } }],
    });
    const live = {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
      Integration: {
        Type: 'MOCK',
        IntegrationResponses: [
          {
            StatusCode: '204',
            ResponseTemplates: { 'application/json': 'x' },
            SelectionPattern: '5\\d{2}', // out-of-band "HTTP error regex"
            ContentHandling: 'CONVERT_TO_TEXT', // out-of-band "content handling"
          },
        ],
      },
    };
    const undeclared = classifyResource(declared, live, bare)
      .filter((f) => f.tier === 'undeclared')
      .map((f) => f.path)
      .sort();
    expect(undeclared).toContain('Integration.IntegrationResponses[204].SelectionPattern');
    expect(undeclared).toContain('Integration.IntegrationResponses[204].ContentHandling');
  });

  it('a clean IntegrationResponses (no extra sub-keys) yields no undeclared drift', () => {
    const el = { StatusCode: '204', ResponseTemplates: { 'application/json': 'x' } };
    const findings = classifyResource(
      method({ Type: 'MOCK', IntegrationResponses: [el] }),
      {
        HttpMethod: 'OPTIONS',
        AuthorizationType: 'NONE',
        Integration: { Type: 'MOCK', IntegrationResponses: [el] },
      },
      bare
    );
    expect(findings.filter((f) => f.tier === 'undeclared')).toHaveLength(0);
  });
});

describe('NESTED_ARRAY_IDENTITY: ApiGateway Method MethodResponses keyed by StatusCode', () => {
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
  const method = (methodResponses: unknown): DesiredResource => ({
    logicalId: 'ApiGET',
    resourceType: 'AWS::ApiGateway::Method',
    physicalId: 'abc|res|GET',
    declared: { HttpMethod: 'GET', AuthorizationType: 'NONE', MethodResponses: methodResponses },
  });

  it('an out-of-band responseModels added to a declared method response surfaces as undeclared', () => {
    const declared = method([{ StatusCode: '200' }]); // template declares NO responseModels
    const live = {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      MethodResponses: [{ StatusCode: '200', ResponseModels: { 'application/json': 'Error' } }],
    };
    const undeclared = classifyResource(declared, live, bare)
      .filter((f) => f.tier === 'undeclared')
      .map((f) => f.path);
    expect(undeclared).toContain('MethodResponses[200].ResponseModels');
  });

  it('a declared responseModels matching live is NOT drift (no FP)', () => {
    const el = { StatusCode: '200', ResponseModels: { 'application/json': 'Empty' } };
    const findings = classifyResource(
      method([el]),
      {
        HttpMethod: 'GET',
        AuthorizationType: 'NONE',
        MethodResponses: [el],
      },
      bare
    );
    expect(findings.filter((f) => f.tier === 'undeclared')).toHaveLength(0);
  });
});

describe('NESTED_ARRAY_IDENTITY: materialized-default array elements (Backup / Route53Resolver)', () => {
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
  const undeclaredPaths = (r: DesiredResource, live: Record<string, unknown>): string[] =>
    classifyResource(r, live, bare)
      .filter((f) => f.tier === 'undeclared')
      .map((f) => f.path)
      .sort();

  it('Backup BackupPlanRule (keyed by RuleName): AWS defaults fold, a changed window surfaces', () => {
    const declared = res('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanRule: [{ RuleName: 'Daily', ScheduleExpression: 'cron(0 3 * * ? *)' }],
      },
    });
    const clean = {
      BackupPlan: {
        BackupPlanRule: [
          {
            RuleName: 'Daily',
            ScheduleExpression: 'cron(0 3 * * ? *)',
            CompletionWindowMinutes: 10080,
            StartWindowMinutes: 480,
            ScheduleExpressionTimezone: 'Etc/UTC',
            CopyActions: [],
          },
        ],
      },
    };
    // all materialized defaults fold (atDefault) or are trivially empty -> no undeclared drift
    expect(undeclaredPaths(declared, clean)).toEqual([]);
    // an out-of-band CompletionWindowMinutes surfaces (no longer the default)
    const drifted = structuredClone(clean);
    (drifted.BackupPlan.BackupPlanRule[0] as Record<string, unknown>).CompletionWindowMinutes =
      5000;
    expect(undeclaredPaths(declared, drifted)).toContain(
      'BackupPlan.BackupPlanRule[Daily].CompletionWindowMinutes'
    );
  });

  it('Route53Resolver FirewallRules (keyed by Priority): redirection default folds, a change surfaces', () => {
    const declared = res('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: [{ Priority: 100, Action: 'BLOCK' }],
    });
    const clean = {
      FirewallRules: [
        {
          Priority: 100,
          Action: 'BLOCK',
          FirewallDomainRedirectionAction: 'INSPECT_REDIRECTION_DOMAIN',
        },
      ],
    };
    expect(undeclaredPaths(declared, clean)).toEqual([]);
    const drifted = {
      FirewallRules: [
        {
          Priority: 100,
          Action: 'BLOCK',
          FirewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN',
        },
      ],
    };
    expect(undeclaredPaths(declared, drifted)).toContain(
      'FirewallRules[100].FirewallDomainRedirectionAction'
    );
  });

  it('SecretsManager ReplicaRegions (keyed by Region): default KmsKeyId folds, a re-key surfaces', () => {
    const declared = res('AWS::SecretsManager::Secret', {
      ReplicaRegions: [{ Region: 'us-west-2' }, { Region: 'eu-west-1' }],
    });
    // AWS materializes the default AWS-managed key into each declared replica (and reorders).
    const clean = {
      ReplicaRegions: [
        { Region: 'eu-west-1', KmsKeyId: 'alias/aws/secretsmanager' },
        { Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager' },
      ],
    };
    expect(undeclaredPaths(declared, clean)).toEqual([]);
    // a replica re-keyed to a custom CMK out of band surfaces (no longer the default)
    const drifted = structuredClone(clean);
    (drifted.ReplicaRegions[1] as Record<string, unknown>).KmsKeyId =
      'arn:aws:kms:us-west-2:111111111111:key/abcd';
    expect(undeclaredPaths(declared, drifted)).toContain('ReplicaRegions[us-west-2].KmsKeyId');
  });

  it('ApiGateway Stage MethodSettings (keyed by HttpMethod): caching defaults fold, a TTL change surfaces', () => {
    const declared = res('AWS::ApiGateway::Stage', {
      MethodSettings: [
        { HttpMethod: '*', ResourcePath: '/*', ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 },
      ],
    });
    // AWS materializes the caching/metrics defaults into the declared method setting.
    const clean = {
      MethodSettings: [
        {
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: 100,
          ThrottlingBurstLimit: 50,
          CacheTtlInSeconds: 300,
          CacheDataEncrypted: false,
          CachingEnabled: false,
          MetricsEnabled: false,
        },
      ],
    };
    expect(undeclaredPaths(declared, clean)).toEqual([]);
    // an out-of-band cache TTL change surfaces (no longer the 300 default)
    const ttl = structuredClone(clean);
    (ttl.MethodSettings[0] as Record<string, unknown>).CacheTtlInSeconds = 600;
    expect(undeclaredPaths(declared, ttl)).toContain('MethodSettings[*].CacheTtlInSeconds');
    // enabling caching out of band (a non-`false` value) surfaces past the isTrivialEmpty fold
    const caching = structuredClone(clean);
    (caching.MethodSettings[0] as Record<string, unknown>).CachingEnabled = true;
    expect(undeclaredPaths(declared, caching)).toContain('MethodSettings[*].CachingEnabled');
  });
});

// A declared NON-EMPTY COLLECTION absent from the live read is, by DEFAULT, real
// `declared` drift (the whole config was removed out of band — AWS omits a sub-config
// when empty but returns it when set). Treating it as a readGap was a silent FALSE
// NEGATIVE ("someone deleted the SSH rule / S3 lifecycle / inline policy in the
// console" reported CLEAN). The exceptions that stay readGap are scalars, EMPTY declared
// collections, and the curated READGAP_COLLECTION_PATHS denylist (collections AWS never
// returns even when set). See READGAP_COLLECTION_PATHS.
describe('absent declared collection → declared drift by default (readGap only by exception)', () => {
  const sgSchema: SchemaInfo = {
    readOnly: new Set(['Id', 'GroupId']),
    writeOnly: new Set(),
    createOnly: new Set(['GroupDescription', 'VpcId']),
    readOnlyPaths: ['Id', 'GroupId'],
    writeOnlyPaths: [],
    createOnlyPaths: ['GroupDescription', 'VpcId'],
    defaults: {},
    defaultPaths: {},
  };
  const rule = {
    CidrIp: '10.0.0.0/16',
    Description: 'ssh from vpc',
    FromPort: 22,
    IpProtocol: 'tcp',
    ToPort: 22,
  };
  const sg = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'Sg',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-123',
    declared,
  });

  it('declared ingress rule removed out of band (CC omits the key) -> declared drift, NOT readGap', () => {
    const findings = classifyResource(
      sg({ GroupDescription: 'd', SecurityGroupIngress: [rule] }),
      // live read omits SecurityGroupIngress entirely (no rules); egress present
      {
        GroupDescription: 'd',
        SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', IpProtocol: '-1', FromPort: -1, ToPort: -1 }],
      },
      sgSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared').map((f) => f.path);
    expect(decl).toContain('SecurityGroupIngress');
    // the removal must NOT be misclassified as an (informational, non-failing) readGap
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'SecurityGroupIngress')).toBe(
      false
    );
  });

  it('declared egress rule removed out of band -> declared drift, NOT readGap', () => {
    const findings = classifyResource(
      sg({ GroupDescription: 'd', SecurityGroupEgress: [rule] }),
      { GroupDescription: 'd' }, // live omits both ingress & egress
      sgSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared').map((f) => f.path);
    expect(decl).toContain('SecurityGroupEgress');
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'SecurityGroupEgress')).toBe(
      false
    );
  });

  it('a still-present ingress rule (CC returns it) compares normally (no false drift)', () => {
    const findings = classifyResource(
      sg({ GroupDescription: 'd', SecurityGroupIngress: [rule] }),
      { GroupDescription: 'd', SecurityGroupIngress: [rule] },
      sgSchema
    );
    expect(findings.filter((f) => f.tier === 'declared')).toHaveLength(0);
    expect(findings.some((f) => f.path === 'SecurityGroupIngress')).toBe(false);
  });

  it('IAM Role inline Policies removed out of band (CC omits Policies) -> declared drift, NOT readGap', () => {
    const roleSchema: SchemaInfo = {
      readOnly: new Set(['Arn', 'RoleId']),
      writeOnly: new Set(),
      createOnly: new Set(),
      readOnlyPaths: ['Arn', 'RoleId'],
      writeOnlyPaths: [],
      createOnlyPaths: [],
      defaults: {},
      defaultPaths: {},
    };
    const policy = {
      PolicyName: 'inline-1',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
      },
    };
    const findings = classifyResource(
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'role-1',
        declared: { RoleName: 'role-1', Policies: [policy] },
      },
      { RoleName: 'role-1' }, // live omits Policies (no inline policies)
      roleSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared').map((f) => f.path);
    expect(decl).toContain('Policies');
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'Policies')).toBe(false);
  });

  it('S3 object-valued config removed out of band (CC omits it) -> ONE whole-property declared drift', () => {
    const s3Schema: SchemaInfo = {
      readOnly: new Set(['Arn']),
      writeOnly: new Set(),
      createOnly: new Set(['BucketName']),
      readOnlyPaths: ['Arn'],
      writeOnlyPaths: [],
      createOnlyPaths: ['BucketName'],
      defaults: {},
      defaultPaths: {},
    };
    const cors = {
      CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['https://example.com'] }],
    };
    const findings = classifyResource(
      {
        logicalId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'b-1',
        declared: { BucketName: 'b-1', CorsConfiguration: cors },
      },
      { BucketName: 'b-1' }, // live omits CorsConfiguration (removed)
      s3Schema
    );
    const decl = findings.filter((f) => f.tier === 'declared');
    // exactly one WHOLE-PROPERTY finding (not a nested CorsConfiguration.CorsRules
    // patch, which would fail to revert: the parent doesn't exist in the live model)
    expect(decl.map((f) => f.path)).toEqual(['CorsConfiguration']);
    expect(decl[0].desired).toEqual(cors);
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'CorsConfiguration')).toBe(
      false
    );
  });

  it('default: an absent declared collection on ANY type detects (no allowlist needed)', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { SomeArray: [rule] },
      },
      {},
      sgSchema
    );
    // the whole class is closed by default — a brand-new type's removed collection
    // surfaces as drift, not a silent readGap
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'SomeArray')).toBe(true);
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'SomeArray')).toBe(false);
  });

  it('exception (denylist): a genuine non-writeOnly readGap collection stays readGap', () => {
    // Batch JobDefinition Timeout / DynamoDB SSESpecification etc. — AWS never returns
    // them even when set, so their absence must NOT be false drift.
    const findings = classifyResource(
      {
        logicalId: 'D',
        resourceType: 'AWS::DynamoDB::Table',
        physicalId: 'd',
        declared: { TableName: 'd', SSESpecification: { SSEEnabled: true } },
      },
      { TableName: 'd' },
      sgSchema
    );
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'SSESpecification')).toBe(true);
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'SSESpecification')).toBe(
      false
    );
  });

  it('exception (scalar): an absent declared SCALAR stays readGap, not drift', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { Port: 5432 },
      },
      {},
      sgSchema
    );
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'Port')).toBe(true);
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'Port')).toBe(false);
  });

  it('allowlist (#507): a cleared declared scalar on a SCALAR_RETURNED_WHEN_SET path -> whole-property declared drift', () => {
    const findings = classifyResource(
      {
        logicalId: 'SuricataGroup',
        resourceType: 'AWS::NetworkFirewall::RuleGroup',
        physicalId: 'rg-1',
        declared: { RuleGroupName: 'rg-1', Description: 'cdkrd suricata blob probe' },
      },
      { RuleGroupName: 'rg-1' }, // live omits Description (cleared out of band)
      sgSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared');
    expect(decl.map((f) => f.path)).toEqual(['Description']);
    expect(decl[0].desired).toBe('cdkrd suricata blob probe');
    expect(decl[0].actual).toBeUndefined();
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'Description')).toBe(false);
  });

  it('allowlist (#507): scoped per-type+path — the same scalar path on an unlisted type stays readGap', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { Description: 'x' },
      },
      {},
      sgSchema
    );
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'Description')).toBe(true);
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'Description')).toBe(false);
  });

  it('allowlist (#507): a still-set Description compares normally (no false drift)', () => {
    const findings = classifyResource(
      {
        logicalId: 'SuricataGroup',
        resourceType: 'AWS::NetworkFirewall::RuleGroup',
        physicalId: 'rg-1',
        declared: { RuleGroupName: 'rg-1', Description: 'same' },
      },
      { RuleGroupName: 'rg-1', Description: 'same' },
      sgSchema
    );
    expect(findings.filter((f) => f.tier === 'declared')).toHaveLength(0);
  });

  it('allowlist (#507): an empty declared Description stays readGap (declared "" vs absent is not drift)', () => {
    const findings = classifyResource(
      {
        logicalId: 'SuricataGroup',
        resourceType: 'AWS::NetworkFirewall::RuleGroup',
        physicalId: 'rg-1',
        declared: { RuleGroupName: 'rg-1', Description: '' },
      },
      { RuleGroupName: 'rg-1' },
      sgSchema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'Description')).toBe(false);
  });

  it('exception (empty collection): an absent EMPTY declared collection is not drift', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { EmptyArr: [], EmptyObj: {} },
      },
      {},
      sgSchema
    );
    // empty declared collection vs absent live is not a removal — stays readGap, never declared
    expect(findings.some((f) => f.tier === 'declared')).toBe(false);
  });
});

// Issue #421 TASK 1 — the NESTED counterpart of the #416 omit-when-empty fix.
//
// #416 closed the TOP-LEVEL silent false negative: a declared non-empty collection
// ABSENT from the live read (the whole `k` key missing) now surfaces as `declared`
// drift instead of an informational readGap. The hypothesis here was that a collection
// removed ONE LEVEL DOWN — declared `{A:{B:[rules]}}` where the live read returns
// `{A:{}}` (A present, B omitted) — bypasses that top-level branch (A IS in live) and
// reaches the deep compare (`calculateResourceDrift`), which might mirror the OLD
// readGap behavior and treat the absent nested key as "no diff" — a SILENT FN one level
// down, the same scary class.
//
// VERIFIED (offline): it is NOT a gap. `calculateResourceDrift`'s subset descent walks
// every DECLARED key; when a declared nested key is absent on the live side it recurses
// with `awsValue === undefined`, deepEqual fails, and the leaf is pushed as drift. So a
// removed nested collection ALREADY surfaces as `declared` drift — this predates #416
// (the deep compare never had the readGap shortcut the top level did). These tests are a
// REGRESSION GUARD locking that in. Revert is also sound: the finding path is the nested
// `A.B`, so the plan emits `add /A/B`, which Cloud Control applies because the PARENT
// `/A` is present in the live model (unlike the top-level case, where the whole property
// is re-added). No code change — the detection and revert paths already cover it.
describe('nested removed collection → declared drift (issue #421 TASK 1 regression guard)', () => {
  const synthSchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const rules = [{ x: 1 }, { x: 2 }];

  it('declared {A:{B:[rules]}} vs live {A:{}} (B omitted) -> declared drift at A.B, not readGap', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { A: { B: rules } },
      },
      { A: {} },
      synthSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared');
    expect(decl.map((f) => f.path)).toEqual(['A.B']);
    expect(decl[0].desired).toEqual(rules);
    expect(decl[0].actual).toBeUndefined();
    // never silently swallowed as an informational readGap
    expect(findings.some((f) => f.tier === 'readGap')).toBe(false);
  });

  it('the nested removal reverts via Cloud Control add /A/B (parent /A is present in live)', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { A: { B: rules } },
      },
      { A: {} },
      synthSchema
    );
    const plan = buildRevertPlan(findings, undefined, {});
    expect(plan.notRevertable).toEqual([]);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    expect(item.kind).toBe('cc'); // Cloud Control UpdateResource, no SDK writer needed
    expect(item.ops).toEqual([expect.objectContaining({ op: 'add', path: '/A/B', value: rules })]);
  });

  it('nested array also emptied to [] (live {A:{B:[]}}) -> declared drift at A.B', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { A: { B: rules } },
      },
      { A: { B: [] } },
      synthSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared');
    expect(decl.map((f) => f.path)).toEqual(['A.B']);
    expect(decl[0].actual).toEqual([]);
  });

  it('collection removed INSIDE an array element (live drops Rules from the element) -> declared drift', () => {
    // declared element keeps its identity (Id) but its nested Rules collection is gone
    // from the live read — the deep compare descends element-wise and flags the leaf.
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { Items: [{ Id: 1, Rules: rules }] },
      },
      { Items: [{ Id: 1 }] },
      synthSchema
    );
    const decl = findings.filter((f) => f.tier === 'declared').map((f) => f.path);
    expect(decl).toEqual(['Items.0.Rules']);
  });

  it('nested collection still present (live returns it) -> no false drift', () => {
    const findings = classifyResource(
      {
        logicalId: 'T',
        resourceType: 'AWS::SomeOther::Type',
        physicalId: 'p',
        declared: { A: { B: rules } },
      },
      { A: { B: rules } },
      synthSchema
    );
    expect(findings.filter((f) => f.tier === 'declared')).toHaveLength(0);
  });
});

describe('issue #462 residual first-run noise folds', () => {
  const bare462: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };

  describe('service-attached log-group policy shell (item 2 + the #464 APS addendum)', () => {
    const logGroup = (live: Record<string, unknown>) =>
      classifyResource(
        {
          logicalId: 'HuntApsLogs',
          resourceType: 'AWS::Logs::LogGroup',
          physicalId: '/aws/vendedlogs/prometheus/cdkrd-hunt',
          constructPath: 'Stack/HuntApsLogs',
          declared: { LogGroupName: '/aws/vendedlogs/prometheus/cdkrd-hunt' },
        },
        { LogGroupName: '/aws/vendedlogs/prometheus/cdkrd-hunt', ...live },
        bare462
      ).find((f) => f.path === 'ResourcePolicyDocument');

    // The REAL policy APS attaches to its vended-logs target group (harvested live
    // from a fresh aps-rich deploy) — the CloudWatch Logs Delivery / VPC flow logs /
    // CloudFront v2 auto-attach carries the same AWSLogDeliveryWrite* + delivery.logs
    // shape. canonicalizePolicy subtracts the statement; the surviving grammar shell
    // must then drop as structural noise, end to end.
    const apsAutoAttached = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AWSLogDeliveryWrite1',
          Effect: 'Allow',
          Principal: { Service: 'delivery.logs.amazonaws.com' },
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource:
            'arn:aws:logs:us-east-1:111111111111:log-group:/aws/vendedlogs/prometheus/cdkrd-hunt:log-stream:*',
          Condition: {
            StringEquals: { 'aws:SourceAccount': '111111111111' },
            ArnLike: { 'aws:SourceArn': 'arn:aws:logs:us-east-1:111111111111:*' },
          },
        },
      ],
    };

    it('the live auto-attached policy (all statements AWS-managed) produces NO finding', () => {
      expect(logGroup({ ResourcePolicyDocument: apsAutoAttached })).toBeUndefined();
    });

    it('a surviving USER statement keeps the document surfaced as undeclared', () => {
      const withUserGrant = {
        ...apsAutoAttached,
        Statement: [
          ...apsAutoAttached.Statement,
          {
            Sid: 'UserGrant',
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::222222222222:root' },
            Action: 'logs:PutLogEvents',
            Resource: '*',
          },
        ],
      };
      expect(logGroup({ ResourcePolicyDocument: withUserGrant })?.tier).toBe('undeclared');
    });

    it('a delivery-shaped statement WITHOUT the AWSLogDelivery Sid is not subtracted and surfaces', () => {
      const attackerShaped = {
        Version: '2012-10-17',
        Statement: [{ ...apsAutoAttached.Statement[0], Sid: 'LooksLikeDelivery' }],
      };
      expect(logGroup({ ResourcePolicyDocument: attackerShaped })?.tier).toBe('undeclared');
    });

    it('a shell carrying a non-boilerplate key is not dropped', () => {
      expect(
        logGroup({
          ResourcePolicyDocument: { Version: '2012-10-17', Statement: [], Extra: { x: 1 } },
        })?.tier
      ).toBe('undeclared');
    });
  });

  describe('self-identity echo wrapper (DeliveryDestinationPolicy shape)', () => {
    const dest = (live: Record<string, unknown>) =>
      classifyResource(
        {
          logicalId: 'DeliveryDest',
          resourceType: 'AWS::Logs::DeliveryDestination',
          physicalId: 'cdkrd-dest',
          constructPath: 'Stack/DeliveryDest',
          declared: {},
        },
        live,
        bare462
      ).find((f) => f.path === 'DeliveryDestinationPolicy');

    it('an empty-policy wrapper carrying only the self-name echo is dropped (structural noise)', () => {
      expect(
        dest({
          DeliveryDestinationPolicy: {
            DeliveryDestinationName: 'cdkrd-dest',
            DeliveryDestinationPolicy: {},
          },
        })
      ).toBeUndefined();
    });

    it('a REAL attached policy still surfaces (payload is not trivially empty)', () => {
      expect(
        dest({
          DeliveryDestinationPolicy: {
            DeliveryDestinationName: 'cdkrd-dest',
            DeliveryDestinationPolicy: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Principal: '*', Action: 'logs:PutLogEvents' }],
            },
          },
        })?.tier
      ).toBe('undeclared');
    });

    it('an echo of a DIFFERENT resource (not the own physical id) still surfaces', () => {
      expect(
        dest({
          DeliveryDestinationPolicy: {
            DeliveryDestinationName: 'someone-elses-dest',
            DeliveryDestinationPolicy: {},
          },
        })?.tier
      ).toBe('undeclared');
    });
  });

  describe('context-derived defaults (CONTEXT_DEFAULTS)', () => {
    const vpces = (live: Record<string, unknown>, region?: string) =>
      classifyResource(
        {
          logicalId: 'EndpointService',
          resourceType: 'AWS::EC2::VPCEndpointService',
          physicalId: 'vpce-svc-0123456789abcdef0',
          constructPath: 'Stack/EndpointService',
          declared: {},
        },
        live,
        bare462,
        region === undefined ? {} : { region }
      ).find((f) => f.path === 'SupportedRegions');

    it('SupportedRegions equal to [own region] folds to atDefault', () => {
      expect(vpces({ SupportedRegions: ['us-east-1'] }, 'us-east-1')?.tier).toBe('atDefault');
    });

    it('extra regions added out of band no longer match and surface as undeclared', () => {
      expect(vpces({ SupportedRegions: ['us-east-1', 'eu-west-1'] }, 'us-east-1')?.tier).toBe(
        'undeclared'
      );
    });

    it('with no resolved region the value stays undeclared (never a wrong fold)', () => {
      expect(vpces({ SupportedRegions: ['us-east-1'] })?.tier).toBe('undeclared');
    });
  });
});

describe('CFn auto-generated name folding (generated tier)', () => {
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
  const sg: DesiredResource = {
    logicalId: 'SgD4954771',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-0f4873d4b3aa50607',
    constructPath: 'CdkRealDriftIntegSg/Sg',
    declared: {},
  };
  const tierOf = (live: Record<string, unknown>, path: string) =>
    classifyResource(sg, live, bare).find((f) => f.path === path)?.tier;

  it('an undeclared CFn-generated name (<stack>-<logicalId>-<random>) folds as generated', () => {
    expect(tierOf({ GroupName: 'CdkRealDriftIntegSg-SgD4954771-8qZ9xcu9LOZR' }, 'GroupName')).toBe(
      'generated'
    );
  });

  it('an undeclared value that is NOT the generated-name shape stays undeclared (no over-fold)', () => {
    // wrong stack prefix
    expect(tierOf({ GroupName: 'other-stack-name-8qZ9xcu9LOZR' }, 'GroupName')).toBe('undeclared');
    // right prefix but no random suffix (a real human-meaningful name)
    expect(tierOf({ GroupName: 'CdkRealDriftIntegSg-web-tier' }, 'GroupName')).toBe('undeclared');
  });

  it('a TRUNCATED CFn-generated short name (<stackPrefix>-<logicalIdPrefix>-<random>) folds as generated', () => {
    // ELBv2 names are capped at 32 chars, so CFn truncates BOTH segments: stack
    // `CdkRealDriftIntegIotVpces` + logical id `NlbBC02D1613` mints
    // `CdkRea-NlbBC-Rz5FCsQXIO7E` (observed live on a fresh auto-named internal NLB).
    const nlb: DesiredResource = {
      logicalId: 'NlbBC02D1613',
      resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      physicalId:
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/CdkRea-NlbBC-Rz5FCsQXIO7E/abc',
      constructPath: 'CdkRealDriftIntegIotVpces/Nlb',
      declared: {},
    };
    const f = classifyResource(nlb, { Name: 'CdkRea-NlbBC-Rz5FCsQXIO7E' }, bare).find(
      (x) => x.path === 'Name'
    );
    expect(f?.tier).toBe('generated');
  });

  it('the truncated branch stays gated: both halves must be prefixes of THIS stack + logical id', () => {
    const nlb = (name: string): [DesiredResource, Record<string, unknown>] => [
      {
        logicalId: 'NlbBC02D1613',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/x/abc',
        constructPath: 'CdkRealDriftIntegIotVpces/Nlb',
        declared: {},
      },
      { Name: name },
    ];
    const tier = (name: string) => {
      const [r, live] = nlb(name);
      return classifyResource(r, live, bare).find((x) => x.path === 'Name')?.tier;
    };
    // stack half is not a prefix of the stack name -> a user-chosen name, surfaces
    expect(tier('MyProd-NlbBC-Rz5FCsQXIO7E')).toBe('undeclared');
    // logical-id half is not a prefix of this resource's logical id -> surfaces
    expect(tier('CdkRea-WebLb-Rz5FCsQXIO7E')).toBe('undeclared');
    // no random suffix -> a human-meaningful name, surfaces
    expect(tier('CdkRea-NlbBC-internal')).toBe('undeclared');
    // stack half must be a STRICT prefix (untruncated names take the strict branch)
    expect(tier('CdkRealDriftIntegIotVpces-NlbBC02D1613-Rz5FCsQXIO7E')).toBe('generated');
  });

  it('no constructPath -> still folds via the logicalId-anchored branch (#888)', () => {
    // An implicitly-created SG (an RDS cluster's / DBProxy's) can lose its aws:cdk:path in the
    // deployed template, so the stack name cannot be derived. The undeclared name still reads back
    // `<stack>-<logicalId>-<random>` — the logical id sits as a whole segment before CFn's random
    // suffix — so it folds anchored on the logical id alone. (An undeclared GroupName can ONLY be
    // the CFn-minted name; a user-set one is DECLARED and compared in the declared loop.)
    const r: DesiredResource = {
      logicalId: 'ClusterSecurityGroup0921994B',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-x',
      declared: {},
    };
    const tier = (name: string) =>
      classifyResource(r, { GroupName: name }, bare).find((x) => x.path === 'GroupName')?.tier;
    // `<stack>-<logicalId>-<random>` with the logical id as a whole non-first segment -> folds
    expect(tier('Any-ClusterSecurityGroup0921994B-8qZ9xcu9LOZR')).toBe('generated');
    // a value whose de-suffixed base does NOT end with this resource's logical id -> surfaces
    expect(tier('Any-OtherLogicalId-8qZ9xcu9LOZR')).toBe('undeclared');
    // a bare `<logicalId>-<random>` (no prefix segment) is NOT folded by this branch -> surfaces
    // (that no-prefix form stays scoped per type+path to avoid over-folding short raw-CFn ids)
    expect(tier('ClusterSecurityGroup0921994B-8qZ9xcu9LOZR')).toBe('undeclared');
  });

  // #509: a BucketDeployment's AwsCliLayer LayerName reads back its bare LOGICAL ID
  // ("CaDeployAwsCliLayer58606CDE") — no `<stack>-` prefix, no extra random suffix — so the
  // strict/truncated shapes above don't match; the logical-id-echo branch folds it.
  it('an undeclared value equal to the resource logical id (bare CFn-generated name) folds as generated', () => {
    const layer: DesiredResource = {
      logicalId: 'CaDeployAwsCliLayer58606CDE',
      resourceType: 'AWS::Lambda::LayerVersion',
      physicalId: 'arn:aws:lambda:us-east-1:111111111111:layer:CaDeployAwsCliLayer58606CDE:1',
      constructPath: 'CdkRealDriftIntegS3LensMiscRich/CaDeploy/AwsCliLayer',
      declared: {},
    };
    const f = classifyResource(layer, { LayerName: 'CaDeployAwsCliLayer58606CDE' }, bare).find(
      (x) => x.path === 'LayerName'
    );
    expect(f?.tier).toBe('generated');
  });

  // The logical-id-echo rule is EXACT-match: a value that is not the logical id verbatim
  // stays undeclared. Tested on a type WITHOUT a value-independent name fold (Lambda
  // LayerVersion's LayerName is folded regardless of value by GENERATED_TOPLEVEL_PATHS, so it
  // cannot isolate this boundary).
  it('an undeclared value merely SIMILAR to the logical id (not exact) stays undeclared', () => {
    const r: DesiredResource = {
      logicalId: 'CaDeployAwsCliLayer58606CDE',
      resourceType: 'AWS::SomeOther::Type',
      physicalId: 'some-physical-id',
      constructPath: 'CdkRealDriftIntegS3LensMiscRich/Thing',
      declared: {},
    };
    const f = classifyResource(r, { CustomName: 'my-custom-name' }, bare).find(
      (x) => x.path === 'CustomName'
    );
    expect(f?.tier).toBe('undeclared');
  });
});

describe('Cloud Control field mis-echo / alternative-representation folds (VPC noise)', () => {
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
  it('AWS::EC2::Route: a non-vpce VpcEndpointId (CC echoing the gateway target) is dropped', () => {
    const r: DesiredResource = {
      logicalId: 'Route',
      resourceType: 'AWS::EC2::Route',
      physicalId: 'rtb-x|0.0.0.0/0',
      declared: { DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0025d639c24016041' },
    };
    const live = {
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: 'igw-0025d639c24016041',
      VpcEndpointId: 'igw-0025d639c24016041',
    };
    expect(classifyResource(r, live, bare).find((f) => f.path === 'VpcEndpointId')).toBeUndefined();
  });
  it('AWS::EC2::Route: a REAL vpce VpcEndpointId still surfaces (not over-dropped)', () => {
    const r: DesiredResource = {
      logicalId: 'Route',
      resourceType: 'AWS::EC2::Route',
      physicalId: 'rtb-x|0.0.0.0/0',
      declared: { DestinationCidrBlock: '0.0.0.0/0' },
    };
    const f = classifyResource(
      r,
      { DestinationCidrBlock: '0.0.0.0/0', VpcEndpointId: 'vpce-abc123' },
      bare
    ).find((x) => x.path === 'VpcEndpointId');
    expect(f?.tier).toBe('undeclared');
  });
  it('AWS::EC2::Subnet: AvailabilityZoneId is dropped when AvailabilityZone is declared', () => {
    const r: DesiredResource = {
      logicalId: 'Subnet',
      resourceType: 'AWS::EC2::Subnet',
      physicalId: 'subnet-x',
      declared: { AvailabilityZone: 'ap-northeast-1a', CidrBlock: '10.0.0.0/24' },
    };
    const live = {
      AvailabilityZone: 'ap-northeast-1a',
      AvailabilityZoneId: 'apne1-az4',
      CidrBlock: '10.0.0.0/24',
    };
    expect(
      classifyResource(r, live, bare).find((f) => f.path === 'AvailabilityZoneId')
    ).toBeUndefined();
  });
  it('AWS::EC2::Subnet: AvailabilityZoneId still surfaces when AvailabilityZone is NOT declared', () => {
    const r: DesiredResource = {
      logicalId: 'Subnet',
      resourceType: 'AWS::EC2::Subnet',
      physicalId: 'subnet-x',
      declared: { CidrBlock: '10.0.0.0/24' },
    };
    const f = classifyResource(
      r,
      { AvailabilityZoneId: 'apne1-az4', CidrBlock: '10.0.0.0/24' },
      bare
    ).find((x) => x.path === 'AvailabilityZoneId');
    expect(f?.tier).toBe('undeclared');
  });
});

// SecurityGroup reflects, in its live SecurityGroupIngress/Egress, the rules declared by
// SIBLING standalone AWS::EC2::SecurityGroupIngress/::SecurityGroupEgress resources (self-ref,
// peer, prefix-list — anything CDK cannot inline). Comparing the SG's INLINE declared rules to
// the full reflected live set false-drifts on every sibling rule. classify subtracts the
// sibling rules (passed in opts.siblingSgRules) before comparing.
describe('SecurityGroup sibling-rule reflection (subtraction)', () => {
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
  const sg: DesiredResource = {
    logicalId: 'Sg',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-1',
    declared: {
      SecurityGroupIngress: [
        { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
      ],
    },
  };
  // live = the one inline rule PLUS two sibling-declared rules AWS merged in (the prefix-list
  // rule reads back verbatim; the self-ref rule reads back with an injected OwnerId).
  const live = {
    SecurityGroupIngress: [
      { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
      { SourcePrefixListId: 'pl-1', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
      {
        SourceSecurityGroupId: 'sg-1',
        SourceSecurityGroupOwnerId: '111111111111',
        IpProtocol: 'tcp',
        FromPort: 9000,
        ToPort: 9000,
      },
    ],
  };
  const siblingSgRules = {
    'sg-1': {
      ingress: [
        { SourcePrefixListId: 'pl-1', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
        {
          SourceSecurityGroupId: 'sg-1',
          SourceSecurityGroupOwnerId: '111111111111',
          IpProtocol: 'tcp',
          FromPort: 9000,
          ToPort: 9000,
        },
      ],
      egress: [] as unknown[],
    },
  };

  it('does NOT false-drift when live reflects sibling-declared rules', () => {
    const t = tiers(classifyResource(sg, structuredClone(live), bare, { siblingSgRules }));
    expect(t.declared).toEqual([]);
  });

  it('without sibling context the reflected rules DO drift (the guard is load-bearing)', () => {
    const t = tiers(classifyResource(sg, structuredClone(live), bare));
    expect(t.declared).toEqual(['SecurityGroupIngress']);
  });

  it('an out-of-band rule matching NO sibling still surfaces as drift', () => {
    const rogue = {
      SecurityGroupIngress: [
        ...live.SecurityGroupIngress,
        { CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 22, ToPort: 22 },
      ],
    };
    const t = tiers(classifyResource(sg, rogue, bare, { siblingSgRules }));
    expect(t.declared).toEqual(['SecurityGroupIngress']);
  });

  // The canonical CDK Aurora shape: `cluster.connections.allowFrom(...)` emits a standalone
  // ingress whose FromPort/ToPort are `Fn::GetAtt <Cluster>.Endpoint.Port`. That GetAtt
  // resolves against the DBCluster's live model, where Endpoint.Port is a STRING ("3306"),
  // while the SG reflects the merged rule with a NUMBER port (3306) — a typed<->string
  // mismatch that must NOT block the sibling subtraction. Observed live on my-app-UserStore-DB.
  it('subtracts a sibling rule whose port is a STRING against a live NUMBER port (GetAtt Endpoint.Port)', () => {
    const sgAurora: DesiredResource = {
      logicalId: 'Sg',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-1',
      declared: {},
    };
    const liveAurora = {
      SecurityGroupIngress: [
        { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
      ],
    };
    const siblings = {
      'sg-1': {
        ingress: [
          { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: '3306', ToPort: '3306' },
        ],
        egress: [] as unknown[],
      },
    };
    const t = tiers(classifyResource(sgAurora, liveAurora, bare, { siblingSgRules: siblings }));
    expect(t.undeclared).toEqual([]);
  });

  // A sibling field the resolver could not evaluate (UNRESOLVED) must act as a wildcard, not
  // block the match — the CidrIp/protocol identity still gates the subtraction.
  it('subtracts a sibling rule whose port is UNRESOLVED (wildcard on the unknowable field)', () => {
    const sgAurora: DesiredResource = {
      logicalId: 'Sg',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-1',
      declared: {},
    };
    const liveAurora = {
      SecurityGroupIngress: [
        { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
      ],
    };
    const siblings = {
      'sg-1': {
        ingress: [
          { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: UNRESOLVED, ToPort: UNRESOLVED },
        ],
        egress: [] as unknown[],
      },
    };
    const t = tiers(classifyResource(sgAurora, liveAurora, bare, { siblingSgRules: siblings }));
    expect(t.undeclared).toEqual([]);
  });

  // The coercion is scoped: a genuinely different port still surfaces (no over-subtraction).
  it('does NOT subtract when the port genuinely differs (string "3307" vs live 3306)', () => {
    const sgAurora: DesiredResource = {
      logicalId: 'Sg',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-1',
      declared: {},
    };
    const liveAurora = {
      SecurityGroupIngress: [
        { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
      ],
    };
    const siblings = {
      'sg-1': {
        ingress: [
          { CidrIp: '192.168.0.0/16', IpProtocol: 'tcp', FromPort: '3307', ToPort: '3307' },
        ],
        egress: [] as unknown[],
      },
    };
    const t = tiers(classifyResource(sgAurora, liveAurora, bare, { siblingSgRules: siblings }));
    expect(t.undeclared).toContain('SecurityGroupIngress');
  });

  it('SecurityGroupIngress SourceSecurityGroupOwnerId folds to generated, not undeclared', () => {
    const ingress: DesiredResource = {
      logicalId: 'SgIn',
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      physicalId: 'sgr-1',
      declared: {
        GroupId: 'sg-1',
        SourceSecurityGroupId: 'sg-1',
        IpProtocol: 'tcp',
        FromPort: 9000,
        ToPort: 9000,
      },
    };
    const liveIn = {
      GroupId: 'sg-1',
      SourceSecurityGroupId: 'sg-1',
      IpProtocol: 'tcp',
      FromPort: 9000,
      ToPort: 9000,
      SourceSecurityGroupOwnerId: '111111111111',
    };
    const t = tiers(classifyResource(ingress, liveIn, bare));
    expect(t.generated).toContain('SourceSecurityGroupOwnerId');
    expect(t.undeclared).not.toContain('SourceSecurityGroupOwnerId');
  });
});

// API Gateway first-run noise found on a real RestApi stack (dev ScoringApi, ap-northeast-1):
// an undeclared EndpointConfiguration and an undeclared Stage MethodSettings throttle pair
// both surfaced as Potential Drift though both are AWS defaults. The RestApi case is the
// regional-variance fold (AWS omits IpAddressType in some regions); the Stage case is the
// account-level throttle defaults (rate 10000 / burst 5000).
describe('API Gateway default-config first-run folds', () => {
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

  it('matchesKnownDefault: deep-equal, sub-object, and the negatives', () => {
    const def = { IpAddressType: 'ipv4', Types: ['EDGE'] };
    expect(matchesKnownDefault({ IpAddressType: 'ipv4', Types: ['EDGE'] }, def)).toBe(true); // full
    expect(matchesKnownDefault({ Types: ['EDGE'] }, def)).toBe(true); // AWS omitted IpAddressType
    expect(matchesKnownDefault({ IpAddressType: 'dualstack', Types: ['EDGE'] }, def)).toBe(false); // real change
    expect(matchesKnownDefault({ Types: ['REGIONAL'] }, def)).toBe(false); // Types changed
    expect(matchesKnownDefault({ Types: ['EDGE'], Extra: 1 }, def)).toBe(false); // extra key not in default
    expect(matchesKnownDefault('HEADER', 'HEADER')).toBe(true); // scalar fallback
    expect(matchesKnownDefault('X', 'HEADER')).toBe(false);
    // #491: a trivially-empty live key the default does NOT list is skipped as residue (a
    // strip husk), so the object still folds against a default that lists only meaningful
    // sub-keys — but a trivially-empty value that CONTRADICTS a non-empty default key
    // ({enabled:false} vs {enabled:true}, #483) is compared, not skipped, so it never folds.
    expect(
      matchesKnownDefault(
        { PricePerformanceTarget: { Status: 'DISABLED' }, Endpoint: [{}, {}] },
        {
          PricePerformanceTarget: { Status: 'DISABLED' },
        }
      )
    ).toBe(true);
    expect(matchesKnownDefault({ enabled: false }, { enabled: true })).toBe(false);
    // AppRunner NetworkConfiguration (bug-hunt apprunner-service-rich): the whole
    // undeclared default folds, but flipping the nested IngressConfiguration to private
    // (IsPubliclyAccessible:false) is a real out-of-band change and must NOT fold.
    const netDef = {
      IpAddressType: 'IPV4',
      EgressConfiguration: { EgressType: 'DEFAULT' },
      IngressConfiguration: { IsPubliclyAccessible: true },
    };
    expect(matchesKnownDefault(netDef, netDef)).toBe(true);
    expect(
      matchesKnownDefault(
        {
          IpAddressType: 'IPV4',
          EgressConfiguration: { EgressType: 'DEFAULT' },
          IngressConfiguration: { IsPubliclyAccessible: false },
        },
        netDef
      )
    ).toBe(false);
  });

  it('RestApi undeclared EndpointConfiguration folds to atDefault even when AWS omits IpAddressType', () => {
    const rest: DesiredResource = {
      logicalId: 'Api',
      resourceType: 'AWS::ApiGateway::RestApi',
      physicalId: 'abc123',
      declared: {},
    };
    // ap-northeast-1 live read: no IpAddressType (the FP this fixes)
    const tA = tiers(classifyResource(rest, { EndpointConfiguration: { Types: ['EDGE'] } }, bare));
    expect(tA.atDefault).toContain('EndpointConfiguration');
    expect(tA.undeclared).not.toContain('EndpointConfiguration');
    // other regions echo the full shape — still atDefault
    const tB = tiers(
      classifyResource(
        rest,
        { EndpointConfiguration: { IpAddressType: 'ipv4', Types: ['EDGE'] } },
        bare
      )
    );
    expect(tB.atDefault).toContain('EndpointConfiguration');
    // a genuine out-of-band change (dual-stack IPv6) still surfaces
    const tC = tiers(
      classifyResource(
        rest,
        { EndpointConfiguration: { IpAddressType: 'dualstack', Types: ['EDGE'] } },
        bare
      )
    );
    expect(tC.undeclared).toContain('EndpointConfiguration');
    expect(tC.atDefault).not.toContain('EndpointConfiguration');
  });

  it('Stage MethodSettings account-default throttle folds to atDefault; a pinned limit surfaces', () => {
    const stage: DesiredResource = {
      logicalId: 'Stage',
      resourceType: 'AWS::ApiGateway::Stage',
      physicalId: 'main',
      // CDK declares the wildcard method setting but no throttle; AWS materializes the
      // account-default throttle into the live element.
      declared: { MethodSettings: [{ HttpMethod: '*', ResourcePath: '/*' }] },
    };
    const liveDefault = {
      MethodSettings: [
        {
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingBurstLimit: 5000,
          ThrottlingRateLimit: 10000,
        },
      ],
    };
    const t = tiers(classifyResource(stage, liveDefault, bare));
    expect(t.atDefault).toEqual([
      'MethodSettings[*].ThrottlingBurstLimit',
      'MethodSettings[*].ThrottlingRateLimit',
    ]);
    expect(t.undeclared).toEqual([]);

    // A throttle pinned out of band away from the account default surfaces (equality-gated).
    const liveChanged = {
      MethodSettings: [
        {
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingBurstLimit: 2000,
          ThrottlingRateLimit: 10000,
        },
      ],
    };
    const t2 = tiers(classifyResource(stage, liveChanged, bare));
    expect(t2.undeclared).toContain('MethodSettings[*].ThrottlingBurstLimit');
    expect(t2.atDefault).toEqual(['MethodSettings[*].ThrottlingRateLimit']);
  });

  // The nested atDefault compare uses the SAME subset-tolerant match as the top-level
  // one, so an OBJECT-valued nested default (KNOWN_DEFAULT_PATHS) that AWS returns with a
  // sub-key omitted folds too — the nested twin of the RestApi EndpointConfiguration fix.
  it('nested object default folds to atDefault when AWS omits a sub-key (Scheduler RetryPolicy)', () => {
    const sched: DesiredResource = {
      logicalId: 'Sched',
      resourceType: 'AWS::Scheduler::Schedule',
      physicalId: 'my-sched',
      declared: { Target: { Arn: 'arn:aws:lambda:us-east-1:1:function:fn', RoleArn: 'arn:role' } },
    };
    // AWS materializes RetryPolicy but returns only MaximumRetryAttempts (omits the
    // MaximumEventAgeInSeconds default) — a strict deepEqual would leak this as undeclared.
    const live = {
      Target: {
        Arn: 'arn:aws:lambda:us-east-1:1:function:fn',
        RoleArn: 'arn:role',
        RetryPolicy: { MaximumRetryAttempts: 185 },
      },
    };
    const t = tiers(classifyResource(sched, live, bare));
    expect(t.atDefault).toContain('Target.RetryPolicy');
    expect(t.undeclared).not.toContain('Target.RetryPolicy');

    // A retry attempt set away from the default still surfaces (equality-gated).
    const liveChanged = {
      Target: {
        Arn: 'arn:aws:lambda:us-east-1:1:function:fn',
        RoleArn: 'arn:role',
        RetryPolicy: { MaximumRetryAttempts: 3 },
      },
    };
    const t2 = tiers(classifyResource(sched, liveChanged, bare));
    expect(t2.undeclared).toContain('Target.RetryPolicy');
    expect(t2.atDefault).not.toContain('Target.RetryPolicy');
  });
});

// FP fixes surfaced by a real dev-stack `check` (reality-vs-intent oracle): the values
// below are SYNTHETIC (no real names), but each class was observed live.
describe('real-stack false-positive folds', () => {
  const mkSchema = (over: Partial<SchemaInfo> = {}): SchemaInfo => ({
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
    ...over,
  });

  it('CloudFront CachePolicy forwarded Headers reorder is NOT drift', () => {
    const res: DesiredResource = {
      logicalId: 'CP',
      resourceType: 'AWS::CloudFront::CachePolicy',
      physicalId: 'cp-1',
      declared: {
        CachePolicyConfig: {
          ParametersInCacheKeyAndForwardedToOrigin: {
            HeadersConfig: { Headers: ['Origin', 'A', 'B'] },
          },
        },
      },
    };
    const live = {
      CachePolicyConfig: {
        ParametersInCacheKeyAndForwardedToOrigin: {
          HeadersConfig: { Headers: ['Origin', 'B', 'A'] },
        },
      },
    };
    expect(tiers(classifyResource(res, live, mkSchema())).declared).toEqual([]);
    // a genuine header change still surfaces
    const changed = {
      CachePolicyConfig: {
        ParametersInCacheKeyAndForwardedToOrigin: {
          HeadersConfig: { Headers: ['Origin', 'B', 'C'] },
        },
      },
    };
    expect(tiers(classifyResource(res, changed, mkSchema())).declared).toEqual([
      'CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers',
    ]);
  });

  it('CloudFront Distribution Aliases reorder is NOT drift', () => {
    const res: DesiredResource = {
      logicalId: 'D',
      resourceType: 'AWS::CloudFront::Distribution',
      physicalId: 'd-1',
      declared: { DistributionConfig: { Aliases: ['apex.example.net', '*.example.net'] } },
    };
    const live = { DistributionConfig: { Aliases: ['*.example.net', 'apex.example.net'] } };
    expect(tiers(classifyResource(res, live, mkSchema())).declared).toEqual([]);
  });

  it('ApplicationSignals SLO BurnRateConfigurations reorder is NOT drift', () => {
    const res: DesiredResource = {
      logicalId: 'SLO',
      resourceType: 'AWS::ApplicationSignals::ServiceLevelObjective',
      physicalId: 'slo-1',
      declared: {
        BurnRateConfigurations: [{ LookBackWindowMinutes: 60 }, { LookBackWindowMinutes: 360 }],
      },
    };
    const live = {
      BurnRateConfigurations: [{ LookBackWindowMinutes: 360 }, { LookBackWindowMinutes: 60 }],
    };
    expect(tiers(classifyResource(res, live, mkSchema())).declared).toEqual([]);
  });

  it('SSM Document DocumentFormat authored YAML vs read-back JSON is NOT drift', () => {
    const res: DesiredResource = {
      logicalId: 'Doc',
      resourceType: 'AWS::SSM::Document',
      physicalId: 'doc-1',
      declared: { DocumentFormat: 'YAML', DocumentType: 'Automation' },
    };
    const live = { DocumentFormat: 'JSON', DocumentType: 'Automation' };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toEqual([]);
  });

  it('KMS KeyPolicy.Id injected by CloudFormation folds to generated (value-independent)', () => {
    const res: DesiredResource = {
      logicalId: 'Key',
      resourceType: 'AWS::KMS::Key',
      physicalId: 'beab2e6f-3dee-4d23-888d-000000000000',
      declared: {
        KeyPolicy: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::111111111111:root' },
              Action: 'kms:*',
              Resource: '*',
            },
          ],
        },
      },
    };
    const live = {
      KeyPolicy: {
        Version: '2012-10-17',
        Id: 'MyStack-Key',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::111111111111:root' },
            Action: 'kms:*',
            Resource: '*',
          },
        ],
      },
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.generated).toEqual(['KeyPolicy.Id']);
    expect(t.undeclared).toEqual([]);
    expect(t.declared).toEqual([]);
  });

  it('ECS AvailabilityZoneRebalancing undeclared folds atDefault for EITHER value', () => {
    const res: DesiredResource = {
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'svc-1',
      declared: {},
    };
    for (const v of ['ENABLED', 'DISABLED']) {
      const t = tiers(classifyResource(res, { AvailabilityZoneRebalancing: v }, mkSchema()));
      expect(t.atDefault).toEqual(['AvailabilityZoneRebalancing']);
      expect(t.undeclared).toEqual([]);
    }
  });

  it('ECS DeploymentController default + service-linked Role fold', () => {
    const res: DesiredResource = {
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'svc-1',
      declared: {},
    };
    const live = {
      DeploymentController: { Type: 'ECS' },
      Role: 'arn:aws:iam::111111111111:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS',
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.atDefault).toEqual(['DeploymentController']);
    expect(t.generated).toEqual(['Role']);
    expect(t.undeclared).toEqual([]);
  });

  it('ECR LifecyclePolicy.RegistryId (account echo) folds to generated', () => {
    const res: DesiredResource = {
      logicalId: 'Repo',
      resourceType: 'AWS::ECR::Repository',
      physicalId: 'repo-1',
      declared: { LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}' } },
    };
    const live = {
      LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}', RegistryId: '111111111111' },
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.generated).toEqual(['LifecyclePolicy.RegistryId']);
    expect(t.undeclared).toEqual([]);
  });

  it('SecurityGroupIngress GroupName echo + ScalingPolicy identity echo fold to generated', () => {
    const sg: DesiredResource = {
      logicalId: 'Ing',
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      physicalId: 'sgr-1',
      declared: { GroupId: 'sg-123', IpProtocol: 'tcp' },
    };
    expect(
      tiers(
        classifyResource(
          sg,
          { GroupId: 'sg-123', IpProtocol: 'tcp', GroupName: 'my-sg' },
          mkSchema()
        )
      ).generated
    ).toEqual(['GroupName']);

    const sp: DesiredResource = {
      logicalId: 'Pol',
      resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
      physicalId: 'pol-1',
      declared: { PolicyName: 'p' },
    };
    const t = tiers(
      classifyResource(
        sp,
        {
          PolicyName: 'p',
          ResourceId: 'service/c/s',
          ServiceNamespace: 'ecs',
          ScalableDimension: 'ecs:service:DesiredCount',
        },
        mkSchema()
      )
    );
    expect(t.generated).toEqual(['ResourceId', 'ScalableDimension', 'ServiceNamespace']);
    expect(t.undeclared).toEqual([]);
  });

  it('ECS PlatformVersion undeclared (AWS-resolved concrete version) folds atDefault', () => {
    const res: DesiredResource = {
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      physicalId: 'svc-1',
      declared: {},
    };
    const t = tiers(classifyResource(res, { PlatformVersion: '1.4.0' }, mkSchema()));
    expect(t.atDefault).toEqual(['PlatformVersion']);
    expect(t.undeclared).toEqual([]);
  });

  it('Lambda default LoggingConfig sub-keys fold; a re-pointed LogGroup surfaces (#703)', () => {
    // The template declares a partial LoggingConfig (as a CDK provider-framework function
    // does); AWS fills in the default LogGroup + format/level, which descend as sub-keys.
    const res: DesiredResource = {
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      physicalId: 'my-fn',
      declared: { FunctionName: 'my-fn', LoggingConfig: { ApplicationLogLevel: 'FATAL' } },
    };
    const live = {
      FunctionName: 'my-fn',
      LoggingConfig: {
        ApplicationLogLevel: 'FATAL',
        LogGroup: '/aws/lambda/my-fn',
        LogFormat: 'Text',
        SystemLogLevel: 'INFO',
      },
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    // #703: the AWS-default LogGroup `/aws/lambda/<name>` now folds via a DERIVED equality gate
    // (atDefault), not the value-independent `generated` fold, so a change away is detectable.
    expect(t.generated).toEqual([]);
    expect(t.atDefault.sort()).toEqual([
      'LoggingConfig.LogFormat',
      'LoggingConfig.LogGroup',
      'LoggingConfig.SystemLogLevel',
    ]);
    expect(t.undeclared).toEqual([]);
    // #703 core: logs RE-POINTED out of band to a custom group must SURFACE (was invisible).
    const repointed = {
      FunctionName: 'my-fn',
      LoggingConfig: {
        ApplicationLogLevel: 'FATAL',
        LogGroup: 'my-custom-log-group',
        LogFormat: 'Text',
        SystemLogLevel: 'INFO',
      },
    };
    expect(tiers(classifyResource(res, repointed, mkSchema())).undeclared).toEqual([
      'LoggingConfig.LogGroup',
    ]);
    // a function that opts into JSON logging still surfaces the non-default LogFormat
    const jsonLive = {
      FunctionName: 'my-fn',
      LoggingConfig: {
        ApplicationLogLevel: 'FATAL',
        LogGroup: '/aws/lambda/my-fn',
        LogFormat: 'JSON',
        SystemLogLevel: 'INFO',
      },
    };
    expect(tiers(classifyResource(res, jsonLive, mkSchema())).undeclared).toEqual([
      'LoggingConfig.LogFormat',
    ]);
  });

  it('ALB SubnetMappings (echo of declared Subnets) is dropped, not undeclared', () => {
    const res: DesiredResource = {
      logicalId: 'Alb',
      resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      physicalId: 'alb-1',
      declared: { Subnets: ['subnet-a', 'subnet-b'] },
    };
    const live = {
      Subnets: ['subnet-a', 'subnet-b'],
      SubnetMappings: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.undeclared).toEqual([]);
    expect(t.declared).toEqual([]);
  });

  it('wholly-undeclared Listener attribute bag folds per-key (empty skipped, server.enabled atDefault)', () => {
    const res: DesiredResource = {
      logicalId: 'Lst',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      physicalId: 'lst-1',
      declared: {},
    };
    const live = {
      ListenerAttributes: [
        { Key: 'routing.http.request.x_amzn_mtls_clientcert.header_name', Value: '' },
        { Key: 'routing.http.response.server.enabled', Value: 'true' },
      ],
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.atDefault).toEqual(['ListenerAttributes[routing.http.response.server.enabled]']);
    expect(t.undeclared).toEqual([]);
    // a genuinely-set mTLS header (non-default, non-empty) still surfaces
    const setLive = {
      ListenerAttributes: [
        { Key: 'routing.http.request.x_amzn_mtls_clientcert.header_name', Value: 'x-cert' },
      ],
    };
    expect(tiers(classifyResource(res, setLive, mkSchema())).undeclared).toEqual([
      'ListenerAttributes[routing.http.request.x_amzn_mtls_clientcert.header_name]',
    ]);
  });

  it('wholly-undeclared NLB LoadBalancerAttributes folds per-LB-type defaults (cross_zone/deletion_protection)', () => {
    const res: DesiredResource = {
      logicalId: 'Nlb',
      resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      physicalId: 'nlb-1',
      declared: { Type: 'network' },
    };
    const live = {
      Type: 'network',
      LoadBalancerAttributes: [
        { Key: 'load_balancing.cross_zone.enabled', Value: 'false' }, // NLB default (BY_LB_TYPE)
        { Key: 'deletion_protection.enabled', Value: 'false' }, // shared default
        { Key: 'access_logs.s3.enabled', Value: 'true' }, // NON-default -> still surfaces
      ],
    };
    const t = tiers(classifyResource(res, live, mkSchema()));
    expect(t.atDefault.sort()).toEqual([
      'LoadBalancerAttributes[deletion_protection.enabled]',
      'LoadBalancerAttributes[load_balancing.cross_zone.enabled]',
    ]);
    expect(t.undeclared).toEqual(['LoadBalancerAttributes[access_logs.s3.enabled]']);
  });

  it('SecretsManager Secret generated Name (no stack prefix) + TargetGroup runtime Targets fold to generated', () => {
    const secret: DesiredResource = {
      logicalId: 'Sec',
      resourceType: 'AWS::SecretsManager::Secret',
      physicalId:
        'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:MyCred-AbCdEf12-x9Y8z7',
      declared: {},
    };
    expect(
      tiers(classifyResource(secret, { Name: 'MyCred-AbCdEf12' }, mkSchema())).generated
    ).toEqual(['Name']);

    const tg: DesiredResource = {
      logicalId: 'Tg',
      resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      physicalId: 'tg-1',
      declared: {},
    };
    const t = tiers(
      classifyResource(
        tg,
        { Targets: [{ Port: 80, AvailabilityZone: 'ap-northeast-1a', Id: '10.0.0.1' }] },
        mkSchema()
      )
    );
    expect(t.generated).toEqual(['Targets']);
    expect(t.undeclared).toEqual([]);
  });
});

describe('ElastiCache/MemoryDB User AccessString canonicalization (#482)', () => {
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
    logicalId: 'R',
    resourceType,
    physicalId: 'p',
    declared,
  });
  const declared = {
    Engine: 'redis',
    UserId: 'reader',
    UserName: 'reader',
    AccessString: 'on ~app:* +@read',
  };

  it('the canonicalized live echo (-@all inserted) is NOT declared drift', () => {
    const findings = classifyResource(
      res('AWS::ElastiCache::User', declared),
      { ...declared, AccessString: 'on ~app:* -@all +@read', Status: 'active' },
      emptySchema
    );
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
  });

  it('an out-of-band grant (+@write) surfaces as declared drift — the #482 FN closed', () => {
    const findings = classifyResource(
      res('AWS::ElastiCache::User', declared),
      { ...declared, AccessString: 'on ~app:* -@all +@read +@write', Status: 'active' },
      emptySchema
    ).filter((f) => f.tier === 'declared');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('AccessString');
  });

  it('the MemoryDB twin folds the same echo and catches the same grant', () => {
    const mdb = { UserName: 'u', AccessString: 'on ~* &* +@read' };
    expect(
      classifyResource(
        res('AWS::MemoryDB::User', mdb),
        { ...mdb, AccessString: 'on ~* &* -@all +@read', Status: 'active' },
        emptySchema
      ).filter((f) => f.tier === 'declared')
    ).toEqual([]);
    expect(
      classifyResource(
        res('AWS::MemoryDB::User', mdb),
        { ...mdb, AccessString: 'on ~* &* -@all +@read +@admin', Status: 'active' },
        emptySchema
      ).filter((f) => f.tier === 'declared')
    ).toHaveLength(1);
  });
});

// Real-stack (my-app-Web) false-positive batch: AWS-materialized defaults + derived
// echoes that flooded a clean first check. Each fold is equality-gated, so a genuine
// out-of-band change still surfaces.
describe('Face-stack false-positive folds', () => {
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
    logicalId: 'R',
    resourceType,
    physicalId: 'phys',
    declared,
  });

  it('Cognito UserPool undeclared default Policies/KeyConfiguration/IssuerConfiguration fold', () => {
    const live = {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true,
          TemporaryPasswordValidityDays: 7,
        },
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
      },
      KeyConfiguration: { KeyType: 'AWS_OWNED_KEY' },
      IssuerConfiguration: { Type: 'ORIGINAL' },
    };
    const t = tiers(classifyResource(res('AWS::Cognito::UserPool', {}), live, emptySchema));
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault.sort()).toEqual(['IssuerConfiguration', 'KeyConfiguration', 'Policies']);
    // a non-default password policy (min length raised) still surfaces
    const drifted = tiers(
      classifyResource(
        res('AWS::Cognito::UserPool', {}),
        { ...live, Policies: { ...live.Policies, PasswordPolicy: { MinimumLength: 12 } } },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['Policies']);
  });

  it('Cognito UserPool partially-declared Schema attr: AWS-filled type/constraints fold', () => {
    const declared = { Schema: [{ Name: 'email', Required: true, Mutable: true }] };
    const live = {
      Schema: [
        {
          Name: 'email',
          Required: true,
          Mutable: true,
          AttributeDataType: 'String',
          StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
        },
      ],
    };
    const t = tiers(classifyResource(res('AWS::Cognito::UserPool', declared), live, emptySchema));
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault.sort()).toEqual([
      'Schema[email].AttributeDataType',
      'Schema[email].StringAttributeConstraints',
    ]);
    // a non-default constraint (custom max length) still surfaces
    const drifted = tiers(
      classifyResource(
        res('AWS::Cognito::UserPool', declared),
        {
          Schema: [
            {
              Name: 'email',
              Required: true,
              Mutable: true,
              AttributeDataType: 'String',
              StringAttributeConstraints: { MinLength: '0', MaxLength: '100' },
            },
          ],
        },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['Schema[email].StringAttributeConstraints']);
  });

  it('Cognito Google IdP derived ProviderDetails endpoints + username mapping fold', () => {
    const declared = {
      ProviderDetails: { client_id: 'x', client_secret: 'y', authorize_scopes: 'openid' },
      AttributeMapping: { email: 'email' },
    };
    const live = {
      ProviderDetails: {
        client_id: 'x',
        client_secret: 'y',
        authorize_scopes: 'openid',
        authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://www.googleapis.com/oauth2/v4/token',
        attributes_url: 'https://people.googleapis.com/v1/people/me?personFields=',
        oidc_issuer: 'https://accounts.google.com',
        token_request_method: 'POST',
        attributes_url_add_attributes: 'true',
      },
      AttributeMapping: { email: 'email', username: 'sub' },
    };
    const t = tiers(
      classifyResource(res('AWS::Cognito::UserPoolIdentityProvider', declared), live, emptySchema)
    );
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toContain('AttributeMapping.username');
    expect(t.atDefault).toContain('ProviderDetails.oidc_issuer');
    // a different (non-Google) endpoint still surfaces
    const drifted = tiers(
      classifyResource(
        res('AWS::Cognito::UserPoolIdentityProvider', declared),
        {
          ...live,
          ProviderDetails: { ...live.ProviderDetails, token_url: 'https://evil.example/token' },
        },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['ProviderDetails.token_url']);
  });

  it('REGIONAL RestApi EndpointConfiguration.IpAddressType=ipv4 folds; dualstack surfaces', () => {
    const declared = { EndpointConfiguration: { Types: ['REGIONAL'] } };
    const clean = tiers(
      classifyResource(
        res('AWS::ApiGateway::RestApi', declared),
        { EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'ipv4' } },
        emptySchema
      )
    );
    expect(clean.undeclared).toEqual([]);
    expect(clean.atDefault).toEqual(['EndpointConfiguration.IpAddressType']);
    const drifted = tiers(
      classifyResource(
        res('AWS::ApiGateway::RestApi', declared),
        { EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'dualstack' } },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['EndpointConfiguration.IpAddressType']);
  });

  it('EventSourceMapping MaximumBatchingWindowInSeconds=0 folds; a real window surfaces', () => {
    const clean = tiers(
      classifyResource(
        res('AWS::Lambda::EventSourceMapping', { FunctionName: 'fn' }),
        { FunctionName: 'fn', MaximumBatchingWindowInSeconds: 0 },
        emptySchema
      )
    );
    expect(clean.undeclared).toEqual([]);
    expect(clean.atDefault).toEqual(['MaximumBatchingWindowInSeconds']);
    const drifted = tiers(
      classifyResource(
        res('AWS::Lambda::EventSourceMapping', { FunctionName: 'fn' }),
        { FunctionName: 'fn', MaximumBatchingWindowInSeconds: 5 },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['MaximumBatchingWindowInSeconds']);
  });

  it('Lambda LoggingConfig.ApplicationLogLevel=INFO folds; a live-only JSON LogFormat surfaces', () => {
    const declared = { LoggingConfig: { LogGroup: '/custom/lg' } };
    const t = tiers(
      classifyResource(
        res('AWS::Lambda::Function', declared),
        {
          LoggingConfig: { LogGroup: '/custom/lg', LogFormat: 'JSON', ApplicationLogLevel: 'INFO' },
        },
        emptySchema
      )
    );
    // the level default folds; the JSON format (default is Text) is a real undeclared value
    expect(t.atDefault).toContain('LoggingConfig.ApplicationLogLevel');
    expect(t.undeclared).toEqual(['LoggingConfig.LogFormat']);
  });

  it('Lambda Durable Function (DurableConfig) LogFormat=JSON folds; a durable Text pin surfaces', () => {
    // A durable function's default log format IS JSON (durable/managed compute substrate),
    // so JSON reads back at default and must fold — unlike a regular function (above).
    const declared = {
      LoggingConfig: { LogGroup: '/custom/lg' },
      DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 30 },
    };
    const durable = tiers(
      classifyResource(
        res('AWS::Lambda::Function', declared),
        {
          LoggingConfig: { LogGroup: '/custom/lg', LogFormat: 'JSON', ApplicationLogLevel: 'INFO' },
          DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 30 },
        },
        emptySchema
      )
    );
    expect(durable.atDefault).toContain('LoggingConfig.LogFormat');
    expect(durable.undeclared).toEqual([]);
    // a durable function that reads back plain Text (not the durable default) still surfaces
    const textPinned = tiers(
      classifyResource(
        res('AWS::Lambda::Function', declared),
        {
          LoggingConfig: { LogGroup: '/custom/lg', LogFormat: 'Text' },
          DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 30 },
        },
        emptySchema
      )
    );
    expect(textPinned.undeclared).toEqual(['LoggingConfig.LogFormat']);
  });

  it('CFn-generated LayerName / ClientName fold to generated', () => {
    // A BucketDeployment's AwsCliLayer reads its LayerName back as its OWN logical id
    // verbatim (the real flood); it folds via isCfnGeneratedName's `value === logicalId`
    // echo — NOT a value-independent LayerName fold, which would also hide an undeclared
    // user-set LayerName (see the "merely SIMILAR" case above).
    const layer = tiers(
      classifyResource(
        {
          logicalId: 'WebsiteDeploymentAwsCliLayer0783B164',
          resourceType: 'AWS::Lambda::LayerVersion',
          physicalId:
            'arn:aws:lambda:us-east-1:111111111111:layer:WebsiteDeploymentAwsCliLayer0783B164:1',
          constructPath: 'Stack/WebsiteDeployment/AwsCliLayer',
          declared: {},
        },
        { LayerName: 'WebsiteDeploymentAwsCliLayer0783B164' },
        emptySchema
      )
    );
    expect(layer.generated).toEqual(['LayerName']);
    expect(layer.undeclared).toEqual([]);
    // A UserPoolClient with no explicit ClientName reads back `<logicalId>-<random>` (no
    // stack prefix); it folds via isCfnGeneratedName's `<logicalId>-<random>` branch — NOT a
    // value-independent ClientName fold, which would also hide an undeclared user-set name.
    const clientResource = {
      logicalId: 'AuthUserPoolUserPoolClientBB863FCC',
      resourceType: 'AWS::Cognito::UserPoolClient',
      physicalId: '3n4b5c6d7e8f9g0h1i2j3k4l5m',
      constructPath: 'Stack/Auth/UserPool/UserPoolClient',
      declared: {},
    };
    const client = tiers(
      classifyResource(
        clientResource,
        { ClientName: 'AuthUserPoolUserPoolClientBB863FCC-qWmhWWbfzd1Q' },
        emptySchema
      )
    );
    expect(client.generated).toEqual(['ClientName']);
    expect(client.undeclared).toEqual([]);
    // A user-SET ClientName (no logical-id prefix) is NOT folded — it surfaces as real
    // undeclared drift, the differentiator cdkrd exists to catch.
    const userSet = tiers(
      classifyResource(clientResource, { ClientName: 'my-app-web-client' }, emptySchema)
    );
    expect(userSet.undeclared).toEqual(['ClientName']);
    expect(userSet.generated).toEqual([]);
  });

  it('Cognito IdentityPool undeclared IdentityPoolName (<logicalId>_<random>) folds to generated', () => {
    // An IdentityPool with no explicit IdentityPoolName reads back `<logicalId>_<random>` —
    // note the UNDERSCORE separator, unlike UserPoolClient's `<logicalId>-<random>`. It folds
    // via GENERATED_LOGICALID_PREFIX_PATHS, NOT a value-independent fold that would also hide a
    // user-set name. Observed live: logical id "IdPool" → "IdPool_r5WzZ9554da2".
    const poolResource = {
      logicalId: 'IdPool',
      resourceType: 'AWS::Cognito::IdentityPool',
      physicalId: 'us-east-1:e04800fe-e59f-4a8a-adba-6d2b1bf9f792',
      constructPath: 'Stack/IdPool',
      declared: {},
    };
    const pool = tiers(
      classifyResource(poolResource, { IdentityPoolName: 'IdPool_r5WzZ9554da2' }, emptySchema)
    );
    expect(pool.generated).toEqual(['IdentityPoolName']);
    expect(pool.undeclared).toEqual([]);
    // A user-SET IdentityPoolName (no logical-id prefix) is NOT folded — it surfaces as real
    // undeclared drift.
    const userSetPool = tiers(
      classifyResource(poolResource, { IdentityPoolName: 'my-app-identities' }, emptySchema)
    );
    expect(userSetPool.undeclared).toEqual(['IdentityPoolName']);
    expect(userSetPool.generated).toEqual([]);
  });

  it('Cognito UserPool undeclared UserPoolName (<logicalId>-<random>) folds to generated', () => {
    // A UserPool with no explicit UserPoolName reads back `<logicalId>-<random>` (the same
    // sibling class as UserPoolClient.ClientName). It folds via GENERATED_LOGICALID_PREFIX_PATHS,
    // NOT a value-independent fold. Observed live across corpus: "Pool88FC4FF9F-jVGU9rNojAd7".
    const poolResource = {
      logicalId: 'Pool88FC4FF9F',
      resourceType: 'AWS::Cognito::UserPool',
      physicalId: 'us-east-1_BUaNF3GfH',
      constructPath: 'Stack/Pool8',
      declared: {},
    };
    const pool = tiers(
      classifyResource(poolResource, { UserPoolName: 'Pool88FC4FF9F-jVGU9rNojAd7' }, emptySchema)
    );
    expect(pool.generated).toEqual(['UserPoolName']);
    expect(pool.undeclared).toEqual([]);
    // A user-SET UserPoolName (no logical-id prefix) still surfaces as real undeclared drift.
    const userSetPool = tiers(
      classifyResource(poolResource, { UserPoolName: 'my-production-pool' }, emptySchema)
    );
    expect(userSetPool.undeclared).toEqual(['UserPoolName']);
    expect(userSetPool.generated).toEqual([]);
  });

  it('Batch JobDefinition undeclared JobDefinitionName (<logicalId>-<random>) folds to generated', () => {
    // A JobDefinition with no explicit JobDefinitionName reads back `<logicalId>-<random>` — the
    // same CFn auto-generated-name class as Cognito ClientName. The logical id carries a CDK
    // construct hash, so the fold cannot coincide with a user-set name. Observed live across
    // corpus: "JobDef97B0969F-HFfibEW0TJakGN1M".
    const jobResource = {
      logicalId: 'JobDef97B0969F',
      resourceType: 'AWS::Batch::JobDefinition',
      physicalId:
        'arn:aws:batch:us-east-1:111111111111:job-definition/JobDef97B0969F-HFfibEW0TJakGN1M:1',
      constructPath: 'Stack/JobDef',
      declared: {},
    };
    const job = tiers(
      classifyResource(
        jobResource,
        { JobDefinitionName: 'JobDef97B0969F-HFfibEW0TJakGN1M' },
        emptySchema
      )
    );
    expect(job.generated).toEqual(['JobDefinitionName']);
    expect(job.undeclared).toEqual([]);
    // A user-SET JobDefinitionName (no logical-id prefix) still surfaces as real undeclared drift.
    const userSetJob = tiers(
      classifyResource(jobResource, { JobDefinitionName: 'my-batch-job' }, emptySchema)
    );
    expect(userSetJob.undeclared).toEqual(['JobDefinitionName']);
    expect(userSetJob.generated).toEqual([]);
  });

  it('EC2 LaunchTemplate undeclared LaunchTemplateName (<logicalId>_<random>) folds to generated (#639)', () => {
    // A LaunchTemplate with no explicit LaunchTemplateName reads back CFn's `<logicalId>_<random>`
    // minted name. It folds via GENERATED_LOGICALID_PREFIX_PATHS, NOT a value-independent fold that
    // would also hide a user-set name. Observed live: logical id "Lt" -> "LtFD2A8520_TE2V74FxIYEe".
    const ltResource = {
      logicalId: 'LtFD2A8520',
      resourceType: 'AWS::EC2::LaunchTemplate',
      physicalId: 'lt-024b5f274d171865a',
      constructPath: 'Stack/Lt',
      declared: {},
    };
    const lt = tiers(
      classifyResource(ltResource, { LaunchTemplateName: 'LtFD2A8520_TE2V74FxIYEe' }, emptySchema)
    );
    expect(lt.generated).toEqual(['LaunchTemplateName']);
    expect(lt.undeclared).toEqual([]);
    // A user-SET LaunchTemplateName (no logical-id prefix) still surfaces as real undeclared drift.
    const userSet = tiers(
      classifyResource(ltResource, { LaunchTemplateName: 'my-web-tier-lt' }, emptySchema)
    );
    expect(userSet.undeclared).toEqual(['LaunchTemplateName']);
    expect(userSet.generated).toEqual([]);
  });

  it('ASG first-run undeclared batch folds (constants + SLR ARN + AZs + nested LT name) (#639)', () => {
    // A clean, un-mutated ASG that declares only VPCZoneIdentifier + a LaunchTemplate ref reads
    // back a batch of AWS-materialized defaults; every one must fold (zero-potential-drift).
    const asgResource = {
      logicalId: 'Asg',
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      physicalId: 'cdkrd-asg',
      constructPath: 'Stack/Asg',
      declared: { LaunchTemplate: { LaunchTemplateId: 'lt-024b5f274d171865a', Version: '1' } },
    };
    const opts = { accountId: '111111111111', region: 'us-east-1' };
    const live = {
      ServiceLinkedRoleARN:
        'arn:aws:iam::111111111111:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling',
      AvailabilityZones: ['us-east-1a', 'us-east-1b'],
      AvailabilityZoneIds: ['use1-az1', 'use1-az2'],
      AvailabilityZoneDistribution: { CapacityDistributionStrategy: 'balanced-best-effort' },
      InstanceLifecyclePolicy: { RetentionTriggers: { TerminateHookAbandon: 'terminate' } },
      TerminationPolicies: ['Default'],
      CapacityReservationSpecification: { CapacityReservationPreference: 'default' },
      LaunchTemplate: {
        LaunchTemplateId: 'lt-024b5f274d171865a',
        Version: '1',
        LaunchTemplateName: 'LtFD2A8520_TE2V74FxIYEe',
      },
    };
    const t = tiers(classifyResource(asgResource, live, emptySchema, opts));
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toEqual([
      'AvailabilityZoneDistribution',
      'AvailabilityZoneIds',
      'AvailabilityZones',
      'CapacityReservationSpecification',
      'InstanceLifecyclePolicy',
      'ServiceLinkedRoleARN',
      'TerminationPolicies',
    ]);
    expect(t.generated).toEqual(['LaunchTemplate.LaunchTemplateName']);
    // Detection preserved: a TerminationPolicies list changed away from the default surfaces,
    // and a custom (non-account) service-linked role ARN surfaces.
    const mutated = tiers(
      classifyResource(
        asgResource,
        {
          ...live,
          TerminationPolicies: ['OldestInstance'],
          ServiceLinkedRoleARN: 'arn:aws:iam::111111111111:role/my-custom-asg-role',
        },
        emptySchema,
        opts
      )
    );
    expect(mutated.undeclared.sort()).toEqual(['ServiceLinkedRoleARN', 'TerminationPolicies']);
  });

  it('ELBv2 TargetGroup health-check defaults derive from TargetType/ProtocolVersion (#648)', () => {
    // gRPC group: interval 30, path /AWS.ALB/healthcheck, Matcher {GrpcCode:12}, threshold 5.
    const grpc = tiers(
      classifyResource(
        {
          logicalId: 'GrpcTg',
          resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          physicalId: 'grpc',
          declared: { TargetType: 'ip', Protocol: 'HTTP', ProtocolVersion: 'GRPC' },
        },
        {
          HealthCheckIntervalSeconds: 30,
          HealthCheckPath: '/AWS.ALB/healthcheck',
          Matcher: { GrpcCode: '12' },
          HealthyThresholdCount: 5,
        },
        emptySchema
      )
    );
    expect(grpc.undeclared).toEqual([]);
    expect(grpc.atDefault.sort()).toEqual([
      'HealthCheckIntervalSeconds',
      'HealthCheckPath',
      'HealthyThresholdCount',
      'Matcher',
    ]);

    // lambda group: interval 35, timeout 30, path / (no ProtocolVersion). ProtocolVersion read
    // from live for an instance group; a lambda group has none.
    const lambda = tiers(
      classifyResource(
        {
          logicalId: 'LamTg',
          resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          physicalId: 'lam',
          declared: { TargetType: 'lambda' },
        },
        {
          HealthCheckIntervalSeconds: 35,
          HealthCheckTimeoutSeconds: 30,
          HealthCheckPath: '/',
          HealthyThresholdCount: 5,
        },
        emptySchema
      )
    );
    expect(lambda.undeclared).toEqual([]);

    // Detection preserved: an out-of-band interval change (a group that never declared it)
    // away from the derived default surfaces as real undeclared drift.
    const drifted = tiers(
      classifyResource(
        {
          logicalId: 'InstTg',
          resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          physicalId: 'inst',
          declared: { TargetType: 'instance', Protocol: 'HTTP' },
        },
        { HealthCheckIntervalSeconds: 60, HealthCheckPath: '/', HealthyThresholdCount: 5 },
        emptySchema
      )
    );
    expect(drifted.undeclared).toEqual(['HealthCheckIntervalSeconds']);
  });

  it('WAF WebACL ByteMatch SearchStringBase64 echo folds; a changed pattern is real drift', () => {
    const declared = {
      Rules: [
        {
          Name: 'RateLimit',
          Statement: {
            RateBasedStatement: {
              ScopeDownStatement: { ByteMatchStatement: { SearchString: '/api/forms/public' } },
            },
          },
        },
      ],
    };
    // live echoes BOTH the plain SearchString AND its redundant base64 twin
    const b64 = Buffer.from('/api/forms/public', 'utf8').toString('base64');
    const live = {
      Rules: [
        {
          Name: 'RateLimit',
          Statement: {
            RateBasedStatement: {
              ScopeDownStatement: {
                ByteMatchStatement: { SearchString: '/api/forms/public', SearchStringBase64: b64 },
              },
            },
          },
        },
      ],
    };
    const clean = tiers(classifyResource(res('AWS::WAFv2::WebACL', declared), live, emptySchema));
    expect(clean.undeclared).toEqual([]);
    expect(clean.declared).toEqual([]);
    // an out-of-band pattern change (both live keys move in lockstep) still surfaces
    const changed = {
      Rules: [
        {
          Name: 'RateLimit',
          Statement: {
            RateBasedStatement: {
              ScopeDownStatement: {
                ByteMatchStatement: {
                  SearchString: '/api/other',
                  SearchStringBase64: Buffer.from('/api/other', 'utf8').toString('base64'),
                },
              },
            },
          },
        },
      ],
    };
    const drifted = classifyResource(res('AWS::WAFv2::WebACL', declared), changed, emptySchema);
    expect(drifted.some((f) => f.tier === 'declared')).toBe(true);
    expect(drifted.some((f) => f.tier === 'undeclared')).toBe(false);
  });

  it('WAF LoggingConfiguration RedactedFields header-name case is not drift; a real change is', () => {
    const declared = { RedactedFields: [{ SingleHeader: { Name: 'Authorization' } }] };
    const clean = classifyResource(
      res('AWS::WAFv2::LoggingConfiguration', declared),
      { RedactedFields: [{ SingleHeader: { Name: 'authorization' } }] },
      emptySchema
    );
    expect(clean.filter((f) => f.tier === 'declared')).toEqual([]);
    const drifted = classifyResource(
      res('AWS::WAFv2::LoggingConfiguration', declared),
      { RedactedFields: [{ SingleHeader: { Name: 'x-custom' } }] },
      emptySchema
    );
    expect(drifted.some((f) => f.tier === 'declared')).toBe(true);
  });

  it('S3 bucket NotificationConfiguration managed by a CR is dropped, not surfaced', () => {
    const live = {
      NotificationConfiguration: {
        TopicConfigurations: [],
        QueueConfigurations: [],
        LambdaConfigurations: [],
        EventBridgeConfiguration: { EventBridgeEnabled: true },
      },
    };
    // no managing CR -> the reflected config surfaces as undeclared
    const surfaced = tiers(classifyResource(res('AWS::S3::Bucket', {}), live, emptySchema));
    expect(surfaced.undeclared).toEqual(['NotificationConfiguration']);
    // a Custom::S3BucketNotifications CR manages this bucket -> dropped
    const dropped = tiers(
      classifyResource(res('AWS::S3::Bucket', {}), live, emptySchema, {
        bucketNotificationManaged: new Set(['phys']),
      })
    );
    expect(dropped.undeclared).toEqual([]);
    // but a bucket that DECLARES NotificationConfiguration inline is still compared
    const declaredInline = classifyResource(
      res('AWS::S3::Bucket', { NotificationConfiguration: { EventBridgeConfiguration: {} } }),
      {
        NotificationConfiguration: {
          EventBridgeConfiguration: {},
          QueueConfigurations: [{ Event: 's3:x' }],
        },
      },
      emptySchema,
      { bucketNotificationManaged: new Set(['phys']) }
    );
    expect(declaredInline.some((f) => f.tier === 'declared' || f.tier === 'undeclared')).toBe(true);
  });
});

describe('ELBv2 TrustStore CA bundle content-hash integrity signal (#505)', () => {
  const schema: SchemaInfo = {
    readOnly: new Set(['NumberOfCaCertificates', 'Status', 'TrustStoreArn']),
    writeOnly: new Set([
      'CaCertificatesBundleS3Bucket',
      'CaCertificatesBundleS3Key',
      'CaCertificatesBundleS3ObjectVersion',
    ]),
    createOnly: new Set(['Name']),
    readOnlyPaths: ['NumberOfCaCertificates', 'Status', 'TrustStoreArn'],
    writeOnlyPaths: [
      'CaCertificatesBundleS3Bucket',
      'CaCertificatesBundleS3Key',
      'CaCertificatesBundleS3ObjectVersion',
    ],
    createOnlyPaths: ['Name'],
    defaults: {},
    defaultPaths: {},
  };
  const res: DesiredResource = {
    logicalId: 'TrustStore',
    resourceType: 'AWS::ElasticLoadBalancingV2::TrustStore',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:truststore/ts/abc',
    declared: {
      Name: 'cdkrd-ts',
      CaCertificatesBundleS3Bucket: 'bkt',
      CaCertificatesBundleS3Key: 'ca.pem',
    },
  };

  it('the supplemented CaCertificatesBundleSha256 surfaces as recordable undeclared drift', () => {
    // The supplement adds the synthetic hash to the live model; it is not a CFn property,
    // so it is undeclared inventory that `record` snapshots and a later swap re-surfaces.
    const findings = classifyResource(
      res,
      {
        Name: 'cdkrd-ts',
        Status: 'ACTIVE',
        NumberOfCaCertificates: 1,
        CaCertificatesBundleSha256: 'f'.repeat(64),
      },
      schema
    );
    const undeclared = findings.filter((f) => f.tier === 'undeclared');
    expect(undeclared.map((f) => f.path)).toContain('CaCertificatesBundleSha256');
    // the writeOnly bundle-location props stay readGaps (correct — unreadable)
    expect(
      findings.some((f) => f.tier === 'readGap' && f.path === 'CaCertificatesBundleS3Bucket')
    ).toBe(true);
  });
});

describe('MSK Configuration ServerProperties properties-file compare (#508)', () => {
  const emptySchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(), // ServerProperties exempted (OVERRIDE_READABLE_WRITEONLY) -> compared
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const res = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'MskConfig',
    resourceType: 'AWS::MSK::Configuration',
    physicalId: 'arn:aws:kafka:us-east-1:111111111111:configuration/c/abc-1',
    declared,
  });
  const declared = {
    Name: 'c',
    ServerProperties:
      'auto.create.topics.enable=false\ndefault.replication.factor=3\nmin.insync.replicas=2\n',
  };

  it('a reformatted-but-equivalent supplemented blob is NOT declared drift', () => {
    const findings = classifyResource(
      res(declared),
      {
        Name: 'c',
        // reordered + comment + blank line (the shape a supplement/echo returns)
        ServerProperties:
          '# stored\nmin.insync.replicas=2\n\ndefault.replication.factor=3\nauto.create.topics.enable=false',
      },
      emptySchema
    );
    expect(findings.filter((f) => f.tier === 'declared')).toEqual([]);
  });

  it('an out-of-band revision (auto.create.topics.enable flipped) surfaces as declared drift — #508 FN closed', () => {
    const findings = classifyResource(
      res(declared),
      {
        Name: 'c',
        ServerProperties:
          'auto.create.topics.enable=true\ndefault.replication.factor=3\nmin.insync.replicas=2\n',
      },
      emptySchema
    ).filter((f) => f.tier === 'declared');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('ServerProperties');
  });
});

describe('#531 EKS + Athena first-run default folds', () => {
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

  it('EKS Cluster: constant service defaults fold; ServiceIpv4Cidr + Version stay record-worthy', () => {
    const res: DesiredResource = {
      logicalId: 'Cluster',
      resourceType: 'AWS::EKS::Cluster',
      physicalId: 'cdkrd-eks',
      declared: {
        Name: 'cdkrd-eks',
        RoleArn: 'arn:aws:iam::111111111111:role/ClusterRole',
        ResourcesVpcConfig: { SubnetIds: ['subnet-a', 'subnet-b'] },
      },
    };
    const live = {
      Name: 'cdkrd-eks',
      RoleArn: 'arn:aws:iam::111111111111:role/ClusterRole',
      ResourcesVpcConfig: {
        SubnetIds: ['subnet-a', 'subnet-b'],
        EndpointPublicAccess: true,
        PublicAccessCidrs: ['0.0.0.0/0'],
        ControlPlaneEgressMode: 'AWS_MANAGED',
        EndpointPrivateAccess: false,
        SecurityGroupIds: [],
      },
      ControlPlaneScalingConfig: { Tier: 'standard' },
      UpgradePolicy: { SupportType: 'EXTENDED' },
      KubernetesNetworkConfig: {
        ServiceIpv4Cidr: '172.20.0.0/16',
        IpFamily: 'ipv4',
        ElasticLoadBalancing: { Enabled: false },
      },
      Version: '1.36',
    };
    const t = tiers(classifyResource(res, live, emptySchema));
    expect(t.atDefault).toEqual([
      'ControlPlaneScalingConfig',
      // #555: KubernetesNetworkConfig is fully undeclared but DESCENDED — its constant IpFamily
      // folds here (ElasticLoadBalancing {Enabled:false} drops as trivially-empty).
      'KubernetesNetworkConfig.IpFamily',
      // #979: ServiceIpv4Cidr is one of two documented constants (KNOWN_DEFAULT_ONE_OF_PATHS).
      'KubernetesNetworkConfig.ServiceIpv4Cidr',
      'ResourcesVpcConfig.ControlPlaneEgressMode',
      'ResourcesVpcConfig.EndpointPublicAccess',
      'ResourcesVpcConfig.PublicAccessCidrs',
      'UpgradePolicy',
      // #979: the undeclared Version is the moving service-default GA (value-independent).
      'Version',
    ]);
    // #979: both per-deploy-variable bits now fold per the zero-first-run invariant.
    expect(t.undeclared).toEqual([]);
  });

  it('EKS Cluster: an out-of-band-narrowed PublicAccessCidrs still surfaces (equality-gated)', () => {
    const res: DesiredResource = {
      logicalId: 'Cluster',
      resourceType: 'AWS::EKS::Cluster',
      physicalId: 'cdkrd-eks',
      declared: { ResourcesVpcConfig: { SubnetIds: ['subnet-a'] } },
    };
    const t = tiers(
      classifyResource(
        res,
        { ResourcesVpcConfig: { SubnetIds: ['subnet-a'], PublicAccessCidrs: ['10.0.0.0/8'] } },
        emptySchema
      )
    );
    expect(t.undeclared).toEqual(['ResourcesVpcConfig.PublicAccessCidrs']);
    expect(t.atDefault).toEqual([]);
  });

  it('EKS Addon: kube-system NamespaceConfig folds; AddonVersion folds value-independent (#979)', () => {
    const res: DesiredResource = {
      logicalId: 'Addon',
      resourceType: 'AWS::EKS::Addon',
      physicalId: 'cdkrd-eks/vpc-cni',
      declared: { AddonName: 'vpc-cni', ClusterName: 'cdkrd-eks' },
    };
    const t = tiers(
      classifyResource(
        res,
        {
          AddonName: 'vpc-cni',
          ClusterName: 'cdkrd-eks',
          NamespaceConfig: { Namespace: 'kube-system' },
          AddonVersion: 'v1.21.2-eksbuild.2',
        },
        emptySchema
      )
    );
    expect(t.atDefault).toEqual(['AddonVersion', 'NamespaceConfig']);
    expect(t.undeclared).toEqual([]);
  });

  it('EKS AccessEntry: derived Username folds value-independent; a declared Username is compared', () => {
    const res: DesiredResource = {
      logicalId: 'Entry',
      resourceType: 'AWS::EKS::AccessEntry',
      physicalId: 'entry-phys',
      declared: {
        ClusterName: 'cdkrd-eks',
        PrincipalArn: 'arn:aws:iam::111111111111:role/EntryRole',
      },
    };
    // Undeclared: whatever derived Username AWS returns folds (value-independent).
    const t = tiers(
      classifyResource(
        res,
        {
          ClusterName: 'cdkrd-eks',
          PrincipalArn: 'arn:aws:iam::111111111111:role/EntryRole',
          Username: 'arn:aws:sts::111111111111:assumed-role/EntryRole/{{SessionName}}',
        },
        emptySchema
      )
    );
    expect(t.atDefault).toEqual(['Username']);
    expect(t.undeclared).toEqual([]);
    // Declared: a user-set Username that drifts surfaces in the declared loop.
    const withDeclared: DesiredResource = {
      ...res,
      declared: { ...res.declared, Username: 'my-user' },
    };
    const t2 = tiers(
      classifyResource(
        withDeclared,
        {
          ClusterName: 'cdkrd-eks',
          PrincipalArn: 'arn:aws:iam::111111111111:role/EntryRole',
          Username: 'changed-out-of-band',
        },
        emptySchema
      )
    );
    expect(t2.declared).toEqual(['Username']);
  });

  it('Athena WorkGroup: a Name/Description-only workgroup folds its whole default WorkGroupConfiguration', () => {
    const res: DesiredResource = {
      logicalId: 'Wg',
      resourceType: 'AWS::Athena::WorkGroup',
      physicalId: 'cdkrd-wg',
      declared: { Name: 'cdkrd-wg', Description: 'probe' },
    };
    const t = tiers(
      classifyResource(
        res,
        {
          Name: 'cdkrd-wg',
          Description: 'probe',
          State: 'ENABLED',
          WorkGroupConfiguration: {
            EnforceWorkGroupConfiguration: true,
            EngineVersion: { SelectedEngineVersion: 'AUTO' },
            PublishCloudWatchMetricsEnabled: true,
            RequesterPaysEnabled: false,
          },
        },
        emptySchema
      )
    );
    expect(t.atDefault).toEqual(['State', 'WorkGroupConfiguration']);
    expect(t.undeclared).toEqual([]);
  });

  it('Athena WorkGroup: a non-default sub-key surfaces alone; the constant defaults still fold (#565)', () => {
    const res: DesiredResource = {
      logicalId: 'Wg',
      resourceType: 'AWS::Athena::WorkGroup',
      physicalId: 'cdkrd-wg',
      declared: { Name: 'cdkrd-wg' },
    };
    const t = tiers(
      classifyResource(
        res,
        {
          Name: 'cdkrd-wg',
          State: 'ENABLED',
          // WorkGroupConfiguration is fully undeclared, but one sub-key (an out-of-band scan cap)
          // is non-default, so the whole-object KNOWN_DEFAULTS fold misses and it is DESCENDED
          // (#565): the constants fold and only BytesScannedCutoffPerQuery surfaces.
          WorkGroupConfiguration: {
            EnforceWorkGroupConfiguration: true,
            EngineVersion: { SelectedEngineVersion: 'AUTO' },
            PublishCloudWatchMetricsEnabled: true,
            RequesterPaysEnabled: false,
            BytesScannedCutoffPerQuery: 10_000_000,
          },
        },
        emptySchema
      )
    );
    expect(t.atDefault).toEqual([
      'State',
      'WorkGroupConfiguration.EnforceWorkGroupConfiguration',
      'WorkGroupConfiguration.EngineVersion',
      'WorkGroupConfiguration.PublishCloudWatchMetricsEnabled',
    ]);
    // RequesterPaysEnabled:false drops as trivially-empty; only the residue surfaces.
    expect(t.undeclared).toEqual(['WorkGroupConfiguration.BytesScannedCutoffPerQuery']);
  });
});

describe('#535 AOSS / SAMLProvider / ENI first-run default folds', () => {
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

  it('AOSS Collection: undeclared DeletionProtection=DISABLED folds; ENABLED surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'Collection',
      resourceType: 'AWS::OpenSearchServerless::Collection',
      physicalId: 'coll-phys',
      declared: { Name: 'cdkrd-aoss', Type: 'VECTORSEARCH' },
    };
    expect(
      tiers(
        classifyResource(
          res,
          { Name: 'cdkrd-aoss', Type: 'VECTORSEARCH', DeletionProtection: 'DISABLED' },
          emptySchema
        )
      ).atDefault
    ).toEqual(['DeletionProtection']);
    expect(
      tiers(
        classifyResource(
          res,
          { Name: 'cdkrd-aoss', Type: 'VECTORSEARCH', DeletionProtection: 'ENABLED' },
          emptySchema
        )
      ).undeclared
    ).toEqual(['DeletionProtection']);
  });

  it('IAM SAMLProvider: undeclared AssertionEncryptionMode=Allowed folds; Required surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'Saml',
      resourceType: 'AWS::IAM::SAMLProvider',
      physicalId: 'arn:aws:iam::111111111111:saml-provider/cdkrd',
      declared: { Name: 'cdkrd', SamlMetadataDocument: '<xml/>' },
    };
    expect(
      tiers(
        classifyResource(res, { Name: 'cdkrd', AssertionEncryptionMode: 'Allowed' }, emptySchema)
      ).atDefault
    ).toEqual(['AssertionEncryptionMode']);
    expect(
      tiers(
        classifyResource(res, { Name: 'cdkrd', AssertionEncryptionMode: 'Required' }, emptySchema)
      ).undeclared
    ).toEqual(['AssertionEncryptionMode']);
  });

  it('EC2 NetworkInterface: undeclared SourceDestCheck=true folds; false (a NAT ENI) surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'Eni',
      resourceType: 'AWS::EC2::NetworkInterface',
      physicalId: 'eni-phys',
      declared: { SubnetId: 'subnet-a' },
    };
    expect(
      tiers(classifyResource(res, { SubnetId: 'subnet-a', SourceDestCheck: true }, emptySchema))
        .atDefault
    ).toContain('SourceDestCheck');
    // SourceDestCheck:false is a NAT/router intent; it is trivially-empty structural noise
    // and (like other false scalars) is dropped rather than surfaced — assert it does NOT fold to atDefault.
    expect(
      tiers(classifyResource(res, { SubnetId: 'subnet-a', SourceDestCheck: false }, emptySchema))
        .atDefault
    ).not.toContain('SourceDestCheck');
  });
});

describe('#529 Logs Transformer order-significant pipeline (revert index skew)', () => {
  // The Transformer schema marks TransformerConfig insertionOrder:false; the fix pins it
  // order-significant so it is NOT sorted, keeping the finding index aligned with the raw
  // live model the Cloud Control revert patches.
  const schema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
    unorderedObjectArrayPaths: ['TransformerConfig'],
  };
  const declaredPipeline = [
    { ParseJSON: {} },
    { AddKeys: { Entries: [{ Key: 'app', OverwriteIfExists: true, Value: 'cdkrd' }] } },
    { TrimString: { WithKeys: ['msg'] } },
  ];
  const res: DesiredResource = {
    logicalId: 'Transformer',
    resourceType: 'AWS::Logs::Transformer',
    physicalId: '/cdkrd/opsmisc/app',
    declared: { TransformerConfig: structuredClone(declaredPipeline) },
  };

  it('a clean pipeline (live == declared order, ParseJSON husk at index 0) is no drift', () => {
    const t = tiers(
      classifyResource(res, { TransformerConfig: structuredClone(declaredPipeline) }, schema)
    );
    expect(t.declared).toEqual([]);
  });

  it('an out-of-band AddKeys.Value edit reports the RAW index (1) and reverts to it', () => {
    const live = structuredClone(declaredPipeline);
    (live[1] as any).AddKeys.Entries[0].Value = 'cdkrd-MUTATED';
    const findings = classifyResource(res, { TransformerConfig: live }, schema);
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared).toHaveLength(1);
    // index 1, NOT the sorted index 0 — the {ParseJSON:{}} husk stays at index 0.
    expect(declared[0]?.path).toBe('TransformerConfig.1.AddKeys.Entries.0.Value');
    const plan = buildRevertPlan(declared, undefined);
    expect(plan.items[0]?.ops[0]?.path).toBe('/TransformerConfig/1/AddKeys/Entries/0/Value');
    expect(plan.items[0]?.ops[0]?.value).toBe('cdkrd');
    expect(plan.notRevertable).toEqual([]);
  });

  it('a genuine processor REORDER surfaces as drift (order is significant, not a set)', () => {
    // Swap AddKeys and TrimString — a real semantic change to the pipeline.
    const live = [declaredPipeline[0], declaredPipeline[2], declaredPipeline[1]];
    const declared = classifyResource(
      res,
      { TransformerConfig: structuredClone(live) },
      schema
    ).filter((f) => f.tier === 'declared');
    expect(declared.length).toBeGreaterThan(0);
  });
});

describe('#555: descend a fully-undeclared object (DESCEND_UNDECLARED_OBJECT_PATHS)', () => {
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

  it('EKS KubernetesNetworkConfig: fold IpFamily + ServiceIpv4Cidr defaults, drop empty ELB (#979)', () => {
    const t = tiers(
      classifyResource(
        bare('AWS::EKS::Cluster'),
        {
          KubernetesNetworkConfig: {
            ServiceIpv4Cidr: '172.20.0.0/16',
            IpFamily: 'ipv4',
            ElasticLoadBalancing: { Enabled: false },
          },
        },
        emptySchema
      )
    );
    // #979: the whole object is split leaf-by-leaf; both the IpFamily constant AND the
    // ServiceIpv4Cidr two-constant default now fold (zero first-run residue).
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toEqual([
      'KubernetesNetworkConfig.IpFamily',
      'KubernetesNetworkConfig.ServiceIpv4Cidr',
    ]);
  });

  it('equality-gated: a non-default IpFamily (ipv6) surfaces; the CIDR still folds (#979)', () => {
    const t = tiers(
      classifyResource(
        bare('AWS::EKS::Cluster'),
        { KubernetesNetworkConfig: { ServiceIpv4Cidr: '10.100.0.0/16', IpFamily: 'ipv6' } },
        emptySchema
      )
    );
    // ipv6 is a real opt-in (surfaces); the CIDR 10.100.0.0/16 is one of the two folded constants.
    expect(t.undeclared).toEqual(['KubernetesNetworkConfig.IpFamily']);
    expect(t.atDefault).toEqual(['KubernetesNetworkConfig.ServiceIpv4Cidr']);
  });

  it('a fully-undeclared object NOT in the allowlist stays ONE whole undeclared finding (no fragmentation)', () => {
    // EKS OutpostConfig is a fully-undeclared object but NOT registered to descend and not a
    // known default — it must remain a single whole-object finding, proving the descend is
    // opt-in per (type, path). (AccessConfig is now a KNOWN_DEFAULTS fold, #653, so it can no
    // longer serve as the undeclared example here.)
    const t = classifyResource(
      bare('AWS::EKS::Cluster'),
      { OutpostConfig: { ControlPlaneInstanceType: 'm5.large' } },
      emptySchema
    );
    expect(t.map((f) => f.path)).toEqual(['OutpostConfig']);
    expect(t[0]!.tier).toBe('undeclared');
    expect(t[0]!.actual).toEqual({ ControlPlaneInstanceType: 'm5.large' });
  });
});

// #632: an undeclared boolean/empty value that DIVERGES from its KNOWN_DEFAULTS pin must
// surface (undeclared) instead of being swallowed by the trivial-empty drop. Before the fix
// the top-level undeclared loop dropped any `false`/`""` via isTrivialEmpty BEFORE consulting
// the fold table, so a `true→false` flip of a switch whose pinned default is `true` (SQS
// SSE-SQS, KMS key Enabled) was completely invisible — undetectable, unrecordable, unrevertable
// (both proven live 2026-07-08). The nested twin (KNOWN_DEFAULT_PATHS) had the same gap.
describe('#632 undeclared boolean flipped off is not swallowed by trivial-empty', () => {
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
  const classify = (
    type: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    classifyResource({ logicalId: 'R', resourceType: type, physicalId: 'p', declared }, live, bare);

  it('SQS SqsManagedSseEnabled=false (KNOWN_DEFAULTS true) surfaces as undeclared', () => {
    const f = classify('AWS::SQS::Queue', {}, { SqsManagedSseEnabled: false });
    const hit = f.find((x) => x.path === 'SqsManagedSseEnabled');
    expect(hit?.tier).toBe('undeclared');
    expect(hit?.actual).toBe(false);
  });

  it('SQS SqsManagedSseEnabled=true (the pin) still folds atDefault (no new FP)', () => {
    const f = classify('AWS::SQS::Queue', {}, { SqsManagedSseEnabled: true });
    expect(f.find((x) => x.path === 'SqsManagedSseEnabled')?.tier).toBe('atDefault');
  });

  it('KMS Key Enabled=false (KNOWN_DEFAULTS true) surfaces as undeclared', () => {
    const f = classify('AWS::KMS::Key', {}, { Enabled: false });
    const hit = f.find((x) => x.path === 'Enabled');
    expect(hit?.tier).toBe('undeclared');
    expect(hit?.actual).toBe(false);
  });

  it('a false value with NO fold entry is still dropped (feature-off husk stays quiet)', () => {
    const f = classify('AWS::SQS::Queue', {}, { SomeUnpinnedFlag: false });
    expect(f.find((x) => x.path === 'SomeUnpinnedFlag')).toBeUndefined();
  });

  it('SSE-KMS queue SqsManagedSseEnabled=false is NOT surfaced (conditional default, no FP)', () => {
    // SSE-SQS and SSE-KMS are mutually exclusive: a queue that declares a KMS key reads
    // SqsManagedSseEnabled=false legitimately on a clean deploy — must stay dropped.
    const f = classify(
      'AWS::SQS::Queue',
      { KmsMasterKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc' },
      { KmsMasterKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc', SqsManagedSseEnabled: false }
    );
    expect(f.find((x) => x.path === 'SqsManagedSseEnabled')).toBeUndefined();
  });
});

// #623: IoT ThingType `ThingTypeProperties.SearchableAttributes` is a nested SCALAR set the
// service re-sorts (declared ["serial","model"] reads back ["model","serial"]). The CFn
// schema annotates it insertionOrder:true so the schema-driven fold does NOT engage — the
// curated UNORDERED_NESTED_OBJECT_ARRAY_PATHS entry folds the reorder while a genuine
// attribute add/remove still surfaces as declared drift. (Was a declared-tier FP that
// survived record and looped revert forever.)
describe('#623 IoT ThingType SearchableAttributes reorder folds (nested scalar set)', () => {
  const bare: SchemaInfo = {
    readOnly: new Set(['Arn', 'Id']),
    writeOnly: new Set(),
    createOnly: new Set(['ThingTypeName']),
    readOnlyPaths: ['Arn', 'Id'],
    writeOnlyPaths: [],
    createOnlyPaths: ['ThingTypeName'],
    defaults: {},
    defaultPaths: {},
  };
  const declaredPaths = (declared: Record<string, unknown>, live: Record<string, unknown>) =>
    classifyResource(
      { logicalId: 'ThingType', resourceType: 'AWS::IoT::ThingType', physicalId: 'p', declared },
      live,
      bare
    )
      .filter((f) => f.tier === 'declared')
      .map((f) => f.path);

  it('a reordered-but-identical attribute set is NOT declared drift', () => {
    expect(
      declaredPaths(
        { ThingTypeProperties: { SearchableAttributes: ['serial', 'model'] } },
        { ThingTypeProperties: { SearchableAttributes: ['model', 'serial'] } }
      )
    ).toEqual([]);
  });

  it('a genuine attribute change still surfaces as declared drift (fail-closed)', () => {
    expect(
      declaredPaths(
        { ThingTypeProperties: { SearchableAttributes: ['serial', 'model'] } },
        { ThingTypeProperties: { SearchableAttributes: ['model', 'firmware'] } }
      )
    ).toEqual(['ThingTypeProperties.SearchableAttributes']);
  });
});

// #618: a Site-to-Site VPN's VpnTunnelOptionsSpecifications is a SET keyed by
// TunnelInsideCidr whose live model is a superset — AWS default-fills each declared spec
// (empty crypto lists + LogOptions-off) AND materializes the second tunnel (a VPN always
// has two). A positional/whole-array compare false-flagged the whole array as DECLARED
// drift that SURVIVED record and whose wholeArrayRevert would push a 1-tunnel array at a
// live 2-tunnel VPN. Aligned by TunnelInsideCidr: declared specs subset-compare, the
// AWS-materialized husk tunnel folds atDefault, a real change still surfaces.
describe('#618 VPNConnection VpnTunnelOptionsSpecifications subset + husk fold', () => {
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
  const tunnelHusk = (cidr: string) => ({
    Phase1EncryptionAlgorithms: [],
    Phase2EncryptionAlgorithms: [],
    Phase1IntegrityAlgorithms: [],
    Phase2IntegrityAlgorithms: [],
    Phase1DHGroupNumbers: [],
    Phase2DHGroupNumbers: [],
    IKEVersions: [],
    TunnelInsideCidr: cidr,
    LogOptions: { CloudwatchLogOptions: { LogEnabled: false, BgpLogEnabled: false } },
  });
  const classify = (declared: Record<string, unknown>, live: Record<string, unknown>) =>
    classifyResource(
      { logicalId: 'Vpn', resourceType: 'AWS::EC2::VPNConnection', physicalId: 'vpn-1', declared },
      live,
      bare
    );

  it('one declared spec + AWS-filled twin + materialized 2nd tunnel → NO declared drift', () => {
    const t = tiers(
      classify(
        { VpnTunnelOptionsSpecifications: [{ TunnelInsideCidr: '169.254.100.0/30' }] },
        {
          VpnTunnelOptionsSpecifications: [
            tunnelHusk('169.254.100.0/30'),
            tunnelHusk('169.254.234.232/30'),
          ],
        }
      )
    );
    expect(t.declared).toEqual([]);
    // the AWS-materialized second tunnel is a pure husk → folded atDefault (not undeclared)
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault).toEqual(['VpnTunnelOptionsSpecifications[169.254.234.232/30]']);
  });

  it('a genuinely removed declared tunnel spec still surfaces as declared drift', () => {
    // declare a CIDR that no live tunnel matches → the declared element has no live twin
    const t = tiers(
      classify(
        { VpnTunnelOptionsSpecifications: [{ TunnelInsideCidr: '169.254.111.0/30' }] },
        {
          VpnTunnelOptionsSpecifications: [
            tunnelHusk('169.254.100.0/30'),
            tunnelHusk('169.254.234.232/30'),
          ],
        }
      )
    );
    expect(t.declared).toEqual(['VpnTunnelOptionsSpecifications']);
  });

  it('a live-only tunnel with REAL (non-husk) content surfaces as undeclared (fail-closed)', () => {
    const realTunnel = {
      ...tunnelHusk('169.254.234.232/30'),
      Phase1EncryptionAlgorithms: ['AES256'],
    };
    const t = tiers(
      classify(
        { VpnTunnelOptionsSpecifications: [{ TunnelInsideCidr: '169.254.100.0/30' }] },
        { VpnTunnelOptionsSpecifications: [tunnelHusk('169.254.100.0/30'), realTunnel] }
      )
    );
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual(['VpnTunnelOptionsSpecifications[169.254.234.232/30]']);
  });
});

// #632 follow-up: extend MEANINGFUL_WHEN_OFF to the UNCONDITIONAL top-level members of the
// blast radius (a fresh deploy always reads them true; no restore/conditional path yields an
// untouched false — corpus-mined, no false-on-clean case). An undeclared false is a real
// out-of-band disable and must surface instead of being swallowed by the trivial-empty drop.
describe('#632 follow-up: unconditional boolean disables surface (undeclared)', () => {
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
  const tierOf = (type: string, key: string, val: unknown) => {
    const f = classifyResource(
      { logicalId: 'R', resourceType: type, physicalId: 'p', declared: {} },
      { [key]: val },
      bare
    );
    return f.find((x) => x.path === key)?.tier;
  };
  const cases: [string, string][] = [
    ['AWS::EC2::VPC', 'EnableDnsSupport'],
    ['AWS::EC2::Instance', 'SourceDestCheck'],
    ['AWS::EC2::NetworkInterface', 'SourceDestCheck'],
    ['AWS::Cognito::UserPoolClient', 'EnableTokenRevocation'],
    ['AWS::CloudWatch::CompositeAlarm', 'ActionsEnabled'],
  ];
  for (const [type, key] of cases) {
    it(`${type} ${key}=false surfaces undeclared; =true folds atDefault`, () => {
      expect(tierOf(type, key, false)).toBe('undeclared');
      expect(tierOf(type, key, true)).toBe('atDefault');
    });
  }
});

// #929: the DECLARED-side twin of #632. The declared trivially-empty husk fold
// (classify.ts ~2291) mutes a declared value when it is trivially-empty AND its live
// side equals a KNOWN_DEFAULTS pin. Because `isTrivialEmpty(false) === true`, a user who
// DECLARES a boolean `false` against a TRUTHY pin (ApplicationInsights CWEMonitorEnabled,
// pinned `true`) had that declared `false` silently folded whenever AWS showed the pinned
// `true` — an out-of-band ENABLE of a monitoring toggle masked as "not drift". Gate the
// husk fold with the SAME MEANINGFUL_WHEN_OFF predicate the undeclared loop uses so the
// declared divergence surfaces, while a genuinely-empty default (R74 CloudTrail
// EventSelectors, a path NOT in the table) keeps folding.
describe('#929 declared boolean false vs truthy KNOWN_DEFAULTS pin is not masked', () => {
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
  const classify = (
    type: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ) =>
    classifyResource({ logicalId: 'R', resourceType: type, physicalId: 'p', declared }, live, bare);

  it('mask-lifted: declared CWEMonitorEnabled=false vs live pinned true surfaces as declared', () => {
    const f = classify(
      'AWS::ApplicationInsights::Application',
      { CWEMonitorEnabled: false },
      { CWEMonitorEnabled: true }
    );
    const hit = f.find((x) => x.path === 'CWEMonitorEnabled');
    expect(hit?.tier).toBe('declared');
    expect(hit?.desired).toBe(false);
    expect(hit?.actual).toBe(true);
  });

  it('natural direction still works: declared true vs live false surfaces as declared', () => {
    const f = classify(
      'AWS::ApplicationInsights::Application',
      { CWEMonitorEnabled: true },
      { CWEMonitorEnabled: false }
    );
    const hit = f.find((x) => x.path === 'CWEMonitorEnabled');
    expect(hit?.tier).toBe('declared');
    expect(hit?.desired).toBe(true);
    expect(hit?.actual).toBe(false);
  });

  it('agree: declared true == live pinned true is not drift', () => {
    const f = classify(
      'AWS::ApplicationInsights::Application',
      { CWEMonitorEnabled: true },
      { CWEMonitorEnabled: true }
    );
    expect(f.find((x) => x.path === 'CWEMonitorEnabled')).toBeUndefined();
  });

  it('still-folds (no over-lift): declared EventSelectors [] materialized to the CloudTrail default folds', () => {
    // R74 precedent — EventSelectors is a KNOWN_DEFAULTS pin NOT listed in MEANINGFUL_WHEN_OFF,
    // so a genuinely-empty declared [] that AWS materialized to the documented management
    // selector must STILL fold (no declared finding).
    const defaultSelector = [
      {
        IncludeManagementEvents: true,
        ReadWriteType: 'All',
        ExcludeManagementEventSources: [],
        DataResources: [],
      },
    ];
    const f = classify(
      'AWS::CloudTrail::Trail',
      { EventSelectors: [] },
      { EventSelectors: defaultSelector }
    );
    expect(f.find((x) => x.path === 'EventSelectors')).toBeUndefined();
  });
});

// #747: a live-only (out-of-band-added) map key containing a `.` / `[` / `]` must NOT be
// appended verbatim as a `${path}.${key}` nested finding path — `toPointer` (and the
// baseline `topSegment` / ignore-rule glob) re-split on `.`/`[`, corrupting the location
// so a revert patches the WRONG place. The declared side already emits the whole map at
// the parent path (drift-calculator `hasPathUnsafeKey`); the UNDECLARED side must mirror
// it. Assert the finding path is the PARENT (`Parameters`), value = the whole live map,
// NOT a split `Parameters.projection.enabled`.
describe('#747 dotted live-only map key -> whole map at parent path (undeclared)', () => {
  const bareSchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };

  it('Glue Table Parameters with Athena projection.enabled emits parent path only', () => {
    const resource: DesiredResource = {
      logicalId: 'Tbl',
      resourceType: 'AWS::Glue::Table',
      physicalId: 'my-table',
      // The property is DECLARED (so the nested-undeclared descent runs) but the dotted key
      // is live-only (out-of-band added / AWS-materialized).
      declared: { Parameters: { classification: 'csv' } },
    };
    const live: Record<string, unknown> = {
      Parameters: { classification: 'csv', 'projection.enabled': 'true' },
    };
    const findings = classifyResource(resource, live, bareSchema);
    const undeclared = findings.filter((f) => f.tier === 'undeclared');
    // Exactly one undeclared finding, at the PARENT path — no split segments.
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].path).toBe('Parameters');
    // NEVER the corrupt per-key path.
    expect(findings.map((f) => f.path)).not.toContain('Parameters.projection.enabled');
    expect(findings.map((f) => f.path)).not.toContain('Parameters.projection');
    // The whole live map is carried so revert rewrites it as a unit.
    expect(undeclared[0].actual).toEqual({
      classification: 'csv',
      'projection.enabled': 'true',
    });
  });

  it('safe live-only keys still descend per-key (guard is scoped to path-unsafe keys)', () => {
    const resource: DesiredResource = {
      logicalId: 'Tbl',
      resourceType: 'AWS::Glue::Table',
      physicalId: 'my-table',
      declared: { Parameters: { classification: 'csv' } },
    };
    const live: Record<string, unknown> = {
      Parameters: { classification: 'csv', safeKey: 'v' },
    };
    const undeclared = classifyResource(resource, live, bareSchema).filter(
      (f) => f.tier === 'undeclared'
    );
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].path).toBe('Parameters.safeKey');
  });

  it('bracket key ([]) also emits parent path only', () => {
    const resource: DesiredResource = {
      logicalId: 'Tbl',
      resourceType: 'AWS::Glue::Table',
      physicalId: 'my-table',
      declared: { Parameters: { a: '1' } },
    };
    const live: Record<string, unknown> = {
      Parameters: { a: '1', 'weird[0]': 'x' },
    };
    const undeclared = classifyResource(resource, live, bareSchema).filter(
      (f) => f.tier === 'undeclared'
    );
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].path).toBe('Parameters');
  });
});

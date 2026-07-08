import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, matchesKnownDefault } from '../src/diff/classify.js';
import { stripCcApiAwsManagedFields } from '../src/normalize/cc-api-strip.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';
import {
  awsManagedTags,
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
  isAllAwsTags,
  isCfnTemplateNonAsciiMask,
  isPemEqual,
  isAccessStringEqual,
  isPropertiesFileEqual,
  isSshPublicKeyEqual,
  SSH_PUBLIC_KEY_PATHS,
  CASE_INSENSITIVE_PATHS,
  CASE_INSENSITIVE_KEY_PATHS,
  isCaseInsensitiveKeyMapEqual,
  isPhysicalIdSegment,
  isTrivialEmpty,
  isVersionPrefixMatch,
  isIntelligentTieringMatch,
  INTELLIGENT_TIERING_PATHS,
  KNOWN_DEFAULTS,
  KNOWN_DEFAULT_ONE_OF,
  KNOWN_DEFAULT_PATHS,
  GENERATED_NESTED_PATHS,
  DESCEND_UNDECLARED_OBJECT_PATHS,
  CONTEXT_ARN_DEFAULTS,
  VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS,
  stripAwsTagsDeep,
  VERSION_PREFIX_PATHS,
  isTrailingDotEqual,
  TRAILING_DOT_PATHS,
  ORDER_SIGNIFICANT_ARRAY_KEYS,
  stripAsymmetricIdentityFields,
} from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import {
  exemptOverrideReadable,
  injectReaderGaps,
  SDK_READER_GAP_PATHS,
  OVERRIDE_READABLE_WRITEONLY,
  SCHEMA_READONLY_SUPPLEMENTS,
  supplementReadOnly,
  parseSchema,
} from '../src/schema/schema-strip.js';

describe('noise suppressors', () => {
  it('isTrivialEmpty: false / "" / [] / {} only', () => {
    expect(isTrivialEmpty(false)).toBe(true);
    expect(isTrivialEmpty('')).toBe(true);
    expect(isTrivialEmpty([])).toBe(true);
    expect(isTrivialEmpty({})).toBe(true);
    expect(isTrivialEmpty(0)).toBe(false); // 0 may be meaningful
    expect(isTrivialEmpty('x')).toBe(false);
    expect(isTrivialEmpty(true)).toBe(false);
  });

  it('isTrivialEmpty: recurses into objects — a feature-off struct is empty (R46)', () => {
    // the empty VpcConfig Lambda materializes after a Cloud Control update
    expect(
      isTrivialEmpty({ Ipv6AllowedForDualStack: false, SecurityGroupIds: [], SubnetIds: [] })
    ).toBe(true);
    expect(isTrivialEmpty({ a: { b: [], c: false }, d: '' })).toBe(true); // nested
    // any real content keeps the struct reported
    expect(isTrivialEmpty({ Status: 'Suspended' })).toBe(false);
    expect(isTrivialEmpty({ a: false, b: 'x' })).toBe(false);
    expect(isTrivialEmpty({ SubnetIds: ['subnet-0aaa111'] })).toBe(false);
    // scalar arrays do NOT recurse — a scalar element keeps the array ([false]/[0]/[""]
    // may be a meaningful list), same conservative stance as the top-level scalars.
    expect(isTrivialEmpty([false])).toBe(false);
    expect(isTrivialEmpty([0])).toBe(false);
    expect(isTrivialEmpty([''])).toBe(false);
    expect(isTrivialEmpty(['x'])).toBe(false);
    expect(isTrivialEmpty({ L: [false] })).toBe(false);
  });

  // #491: a NON-empty array of recursively-empty OBJECTS is the signature shape of
  // schema-strip residue (an echo attribute's leaves readOnly-stripped, leaving `[{},{}]`
  // husks — RedshiftServerless Workgroup Endpoint VpcEndpoints[].NetworkInterfaces).
  // Objects-ONLY recursion folds it while keeping the conservative scalar-array stance.
  it('isTrivialEmpty: an array of recursively-empty objects folds ([{},{}] strip husk, #491)', () => {
    expect(isTrivialEmpty([{}, {}])).toBe(true);
    expect(isTrivialEmpty([{ a: false, b: [] }])).toBe(true);
    // the exact RedshiftServerless Workgroup Endpoint husk
    expect(isTrivialEmpty({ VpcEndpoints: [{ NetworkInterfaces: [{}, {}] }] })).toBe(true);
    // per-deploy ENI count is irrelevant — 3 ENIs still folds
    expect(isTrivialEmpty({ VpcEndpoints: [{ NetworkInterfaces: [{}, {}, {}] }] })).toBe(true);
    // a MIXED array (an object husk plus a scalar) does NOT fold — the scalar keeps it
    expect(isTrivialEmpty([{}, 'x'])).toBe(false);
    // an object with real content inside the array element keeps the array
    expect(isTrivialEmpty([{ NetworkInterfaceId: 'eni-1' }])).toBe(false);
  });

  it('canonicalizeTagListsDeep: sorts {Key,Value}[] by Key so reordering is not drift', () => {
    const a = canonicalizeTagListsDeep({
      Tags: [
        { Key: 'Name', Value: 'n' },
        { Key: 'aws-cdk:subnet-type', Value: 't' },
        { Key: 'aws-cdk:subnet-name', Value: 's' },
      ],
    });
    const b = canonicalizeTagListsDeep({
      Tags: [
        { Key: 'aws-cdk:subnet-name', Value: 's' },
        { Key: 'aws-cdk:subnet-type', Value: 't' },
        { Key: 'Name', Value: 'n' },
      ],
    });
    expect(a).toEqual(b);
    expect((a as { Tags: { Key: string }[] }).Tags.map((t) => t.Key)).toEqual([
      'Name',
      'aws-cdk:subnet-name',
      'aws-cdk:subnet-type',
    ]);
  });

  it('canonicalizeTagListsDeep: recurses + leaves non-tag arrays positional', () => {
    expect(canonicalizeTagListsDeep({ A: { Tags: [{ Key: 'b' }, { Key: 'a' }] } })).toEqual({
      A: { Tags: [{ Key: 'a' }, { Key: 'b' }] },
    });
    // a plain list (no Key on every element) keeps its order
    expect(canonicalizeTagListsDeep({ L: [3, 1, 2] })).toEqual({ L: [3, 1, 2] });
    expect(canonicalizeTagListsDeep({ L: [{ Key: 'a' }, { X: 1 }] })).toEqual({
      L: [{ Key: 'a' }, { X: 1 }],
    });
  });

  it('canonicalizeTagListsDeep: sorts Id-keyed object arrays (CloudFront Origins)', () => {
    // a multi-origin distribution returns Origins in a different order than declared;
    // sorting by Id makes the reordered-but-equal set compare equal (no false drift).
    const declared = {
      Origins: [
        { Id: 'Origin1', DomainName: 'a.lambda-url.aws', OriginAccessControlId: 'E36' },
        { Id: 'Origin2', DomainName: 'b.lambda-url.aws', OriginAccessControlId: 'ELD' },
      ],
    };
    const live = {
      Origins: [
        { Id: 'Origin2', DomainName: 'b.lambda-url.aws', OriginAccessControlId: 'ELD' },
        { Id: 'Origin1', DomainName: 'a.lambda-url.aws', OriginAccessControlId: 'E36' },
      ],
    };
    expect(canonicalizeTagListsDeep(declared)).toEqual(canonicalizeTagListsDeep(live));
    // a genuine change to one origin (same Id, different DomainName) still differs
    const changed = {
      Origins: [
        { Id: 'Origin2', DomainName: 'CHANGED.aws', OriginAccessControlId: 'ELD' },
        { Id: 'Origin1', DomainName: 'a.lambda-url.aws', OriginAccessControlId: 'E36' },
      ],
    };
    expect(canonicalizeTagListsDeep(declared)).not.toEqual(canonicalizeTagListsDeep(changed));
  });

  it('canonicalizeTagListsDeep: order-significant Name-keyed arrays are NOT sorted (CodePipeline)', () => {
    // CodePipeline Stages/Actions carry a per-element Name (so identityField would sort
    // them) but their order is semantically significant AND the revert patch addresses
    // the raw live model by index — sorting would misalign the finding index. With the
    // type's order-significant key set, the array must stay in DECLARED order.
    const orderSig = ORDER_SIGNIFICANT_ARRAY_KEYS['AWS::CodePipeline::Pipeline'];
    const pipeline = {
      Stages: [
        { Name: 'Source', Actions: [{ Name: 'Src', Configuration: { x: '1' } }] },
        { Name: 'Build', Actions: [{ Name: 'Bld', Configuration: { x: '2' } }] },
      ],
    };
    // default (no orderSig) WOULD reorder Build before Source — proving the regression risk
    expect(
      (canonicalizeTagListsDeep(pipeline) as { Stages: { Name: string }[] }).Stages.map(
        (s) => s.Name
      )
    ).toEqual(['Build', 'Source']);
    // with orderSig, Stages keep declared order (index stays aligned with the raw model)
    expect(
      (canonicalizeTagListsDeep(pipeline, orderSig) as { Stages: { Name: string }[] }).Stages.map(
        (s) => s.Name
      )
    ).toEqual(['Source', 'Build']);
  });

  it('canonicalizeTagListsDeep: order-significant exclusion still recurses into elements (nested Tags sorted)', () => {
    // the array under an order-significant key is not sorted, but its ELEMENTS still get
    // canonicalized — a Tags list inside a Stage is still sorted by Key.
    const orderSig = ORDER_SIGNIFICANT_ARRAY_KEYS['AWS::CodePipeline::Pipeline'];
    const out = canonicalizeTagListsDeep(
      {
        Stages: [
          {
            Name: 'B',
            Tags: [
              { Key: 'z', Value: '1' },
              { Key: 'a', Value: '2' },
            ],
          },
          { Name: 'A' },
        ],
      },
      orderSig
    ) as { Stages: { Name: string; Tags?: { Key: string }[] }[] };
    expect(out.Stages.map((s) => s.Name)).toEqual(['B', 'A']); // stage order preserved
    expect(out.Stages[0].Tags?.map((t) => t.Key)).toEqual(['a', 'z']); // nested Tags sorted
  });

  it('canonicalizeForCompare: passes a type through so CodePipeline Stages compare positionally', () => {
    const declared = {
      Stages: [
        { Name: 'Source', Actions: [{ Name: 'S' }] },
        { Name: 'Build', Actions: [{ Name: 'B' }] },
      ],
    };
    // type-aware: declared order preserved (no false reorder, index aligned for revert)
    expect(
      (
        canonicalizeForCompare(declared, 'AWS::CodePipeline::Pipeline') as {
          Stages: { Name: string }[];
        }
      ).Stages.map((s) => s.Name)
    ).toEqual(['Source', 'Build']);
    // type-LESS (e.g. baseline/writers callers) keeps the legacy sort — unchanged behavior
    expect(
      (canonicalizeForCompare(declared) as { Stages: { Name: string }[] }).Stages.map((s) => s.Name)
    ).toEqual(['Build', 'Source']);
    // a genuine reorder of stages is now DETECTABLE (type-aware sides differ)
    const reordered = {
      Stages: [
        { Name: 'Build', Actions: [{ Name: 'B' }] },
        { Name: 'Source', Actions: [{ Name: 'S' }] },
      ],
    };
    expect(canonicalizeForCompare(declared, 'AWS::CodePipeline::Pipeline')).not.toEqual(
      canonicalizeForCompare(reordered, 'AWS::CodePipeline::Pipeline')
    );
  });

  it('canonicalizeIdArraysDeep: sorts resource-id/ARN arrays (SubnetIds) but not plain scalars', () => {
    const a = canonicalizeIdArraysDeep({ SubnetIds: ['subnet-0fb5ef44', 'subnet-0daf2ccb'] });
    const b = canonicalizeIdArraysDeep({ SubnetIds: ['subnet-0daf2ccb', 'subnet-0fb5ef44'] });
    expect(a).toEqual(b);
    // a plain non-id scalar list keeps its order (could be semantically ordered)
    expect(canonicalizeIdArraysDeep({ Order: ['b', 'a'] })).toEqual({ Order: ['b', 'a'] });
    // ARNs are sorted too
    expect(canonicalizeIdArraysDeep(['arn:aws:s3:::b', 'arn:aws:s3:::a']) as string[]).toEqual([
      'arn:aws:s3:::a',
      'arn:aws:s3:::b',
    ]);
  });

  it('canonicalizeIdArraysDeep: sorts HTTP-method sets (CloudFront AllowedMethods)', () => {
    // CloudFront returns AllowedMethods in a different order than CDK declares them;
    // the verb set is unordered, so canonicalization must make them compare equal.
    const declared = canonicalizeIdArraysDeep({
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
    });
    const live = canonicalizeIdArraysDeep({
      AllowedMethods: ['HEAD', 'DELETE', 'POST', 'GET', 'OPTIONS', 'PUT', 'PATCH'],
    });
    expect(declared).toEqual(live);
    // the smaller cached-methods subset also normalizes
    expect(canonicalizeIdArraysDeep(['HEAD', 'GET'])).toEqual(['GET', 'HEAD']);
    // a NON-method scalar list mixed with a method token is left alone (real drift kept)
    expect(canonicalizeIdArraysDeep(['GET', 'CUSTOM'])).toEqual(['GET', 'CUSTOM']);
  });

  it('canonicalizeIdArraysDeep: sorts AvailabilityZones name/id sets (no hex suffix)', () => {
    // Observed live (RDS DBCluster corpus): AWS reads an AZ list back in assignment
    // order [us-east-1c, us-east-1a, us-east-1b], NOT declared order — but ID_RE can't
    // match an AZ name (no hex suffix), so it needs the parallel isAvailabilityZone test.
    const declared = canonicalizeIdArraysDeep({
      AvailabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
    });
    const live = canonicalizeIdArraysDeep({
      AvailabilityZones: ['us-east-1c', 'us-east-1a', 'us-east-1b'],
    });
    expect(declared).toEqual(live);
    // AZ IDs (use1-az1) are folded too
    expect(canonicalizeIdArraysDeep(['use1-az2', 'use1-az1'])).toEqual(['use1-az1', 'use1-az2']);
    // a 3-segment region name (us-gov-east-1a) is still an AZ
    expect(canonicalizeIdArraysDeep(['us-gov-east-1b', 'us-gov-east-1a']) as string[]).toEqual([
      'us-gov-east-1a',
      'us-gov-east-1b',
    ]);
    // a plain non-AZ scalar list keeps its order (could be semantically ordered)
    expect(canonicalizeIdArraysDeep({ Order: ['zone-b', 'zone-a'] })).toEqual({
      Order: ['zone-b', 'zone-a'],
    });
  });

  it('canonicalizeIdArraysDeep: does NOT sort the order-significant Lambda Layers ARN list', () => {
    // Lambda Function.Layers is order-significant (later layers overlay earlier).
    // The generic ARN sort would suppress a genuine reorder — a false negative.
    const layersA = [
      'arn:aws:lambda:us-east-1:123456789012:layer:libA:3',
      'arn:aws:lambda:us-east-1:123456789012:layer:libB:1',
    ];
    const layersB = [
      'arn:aws:lambda:us-east-1:123456789012:layer:libB:1',
      'arn:aws:lambda:us-east-1:123456789012:layer:libA:3',
    ];
    // each side is preserved verbatim (NOT sorted) ...
    expect(canonicalizeIdArraysDeep({ Layers: layersA })).toEqual({ Layers: layersA });
    expect(canonicalizeIdArraysDeep({ Layers: layersB })).toEqual({ Layers: layersB });
    // ... so a reorder stays distinguishable (would surface as drift)
    expect(canonicalizeIdArraysDeep({ Layers: layersA })).not.toEqual(
      canonicalizeIdArraysDeep({ Layers: layersB })
    );
    // a NON-layer ARN list (e.g. SecurityGroupIds) still sorts as before
    expect(canonicalizeIdArraysDeep(['arn:aws:s3:::b', 'arn:aws:s3:::a']) as string[]).toEqual([
      'arn:aws:s3:::a',
      'arn:aws:s3:::b',
    ]);
  });

  it('isStringlyEqualScalar: a primitive equals its String() form, real drift kept', async () => {
    const { isStringlyEqualScalar } = await import('../src/normalize/noise.js');
    expect(isStringlyEqualScalar(true, 'true')).toBe(true);
    expect(isStringlyEqualScalar('true', true)).toBe(true);
    expect(isStringlyEqualScalar(5432, '5432')).toBe(true);
    // real drift is preserved
    expect(isStringlyEqualScalar(true, 'false')).toBe(false);
    expect(isStringlyEqualScalar(5, '6')).toBe(false);
    // never collapses two strings or objects
    expect(isStringlyEqualScalar('true', 'true')).toBe(false);
    expect(isStringlyEqualScalar({ a: 1 }, '[object Object]')).toBe(false);
  });

  it('isStringlyEqualScalar: numeric FORMATTING variants fold, value changes do not (R67)', async () => {
    const { isStringlyEqualScalar } = await import('../src/normalize/noise.js');
    // AWS decimal-string forms of a declared number (Budgets BudgetLimit.Amount)
    expect(isStringlyEqualScalar(5, '5.0')).toBe(true);
    expect(isStringlyEqualScalar('40.00', 40)).toBe(true);
    expect(isStringlyEqualScalar(1500, '1.5e3')).toBe(true);
    // real drift preserved
    expect(isStringlyEqualScalar(5, '5.5')).toBe(false);
    // strict decimal literal only: no '' -> 0, no hex, booleans never numeric
    expect(isStringlyEqualScalar(0, '')).toBe(false);
    expect(isStringlyEqualScalar(16, '0x10')).toBe(false);
    expect(isStringlyEqualScalar(true, '1')).toBe(false);
  });

  it('isJsonStringStructEqual: folds typed<->string leaves inside a JSON-string prop', async () => {
    const { isJsonStringStructEqual } = await import('../src/normalize/noise.js');
    // A declared structured object whose live counterpart is the same value serialized as
    // a JSON string, but with the numeric/boolean leaves quoted (AWS stringifies everything
    // inside a JSON-string prop). Strict `===` at the leaves would false-drift the whole prop.
    expect(
      isJsonStringStructEqual(
        { Port: 443, Tls: true, Name: 'db' },
        '{"Port":"443","Tls":"true","Name":"db"}'
      )
    ).toBe(true);
    // order-insensitive on the object keys, same as the all-string case
    expect(
      isJsonStringStructEqual('{"Tls":"true","Port":"443","Name":"db"}', {
        Port: 443,
        Tls: true,
        Name: 'db',
      })
    ).toBe(true);
    // nested + array leaves fold too
    expect(
      isJsonStringStructEqual(
        { Cfg: { Retries: 3, Ports: [80, 443] } },
        '{"Cfg":{"Retries":"3","Ports":["80","443"]}}'
      )
    ).toBe(true);
    // a GENUINE value change at a leaf still differs (443 vs 8080)
    expect(isJsonStringStructEqual({ Port: 443 }, '{"Port":"8080"}')).toBe(false);
    // a genuine boolean flip still differs
    expect(isJsonStringStructEqual({ Tls: true }, '{"Tls":"false"}')).toBe(false);
    // structural mismatch (missing key) still differs
    expect(isJsonStringStructEqual({ Port: 443, Extra: 1 }, '{"Port":"443"}')).toBe(false);
  });

  it('isStringlyEqualScalarArray: typed<->string element arrays fold, real drift kept (R23)', async () => {
    const { isStringlyEqualScalarArray } = await import('../src/normalize/noise.js');
    // declared typed ports vs AWS stringly form, same order
    expect(isStringlyEqualScalarArray([80, 443], ['80', '443'])).toBe(true);
    expect(isStringlyEqualScalarArray(['80', '443'], [80, 443])).toBe(true);
    expect(isStringlyEqualScalarArray([true, false], ['true', 'false'])).toBe(true);
    // R67 numeric formatting carries through element-wise
    expect(isStringlyEqualScalarArray([5, 40], ['5.0', '40.00'])).toBe(true);
    // identical arrays (strict) still fold
    expect(isStringlyEqualScalarArray(['a', 'b'], ['a', 'b'])).toBe(true);
    // a genuine element change still differs
    expect(isStringlyEqualScalarArray([80, 443], ['80', '8443'])).toBe(false);
    // length change is real drift
    expect(isStringlyEqualScalarArray([80], [80, 443])).toBe(false);
    // ORDER matters (unordered sets are handled separately by UNORDERED_ARRAY_PROPS)
    expect(isStringlyEqualScalarArray([80, 443], ['443', '80'])).toBe(false);
    // never collapses object/nested arrays (those have their own canonicalizers)
    expect(isStringlyEqualScalarArray([{ a: 1 }], ['[object Object]'])).toBe(false);
    expect(isStringlyEqualScalarArray([[1]], [['1']])).toBe(false);
    // non-arrays
    expect(isStringlyEqualScalarArray(80, '80')).toBe(false);
  });

  it('isStringlyEqualDeep: whole free-form map typed<->string coercion folds, real drift kept', async () => {
    const { isStringlyEqualDeep } = await import('../src/normalize/noise.js');
    // the reported repro: Glue Parameters map emitted whole — one boolean value
    // declared typed by CDK but stored as a string by Glue (Map<String,String>)
    expect(
      isStringlyEqualDeep(
        { 'projection.enabled': true, 'skip.header.line.count': 2, 'projection.date.type': 'date' },
        {
          'projection.date.type': 'date',
          'skip.header.line.count': '2',
          'projection.enabled': 'true',
        }
      )
    ).toBe(true);
    // numeric formatting variants fold per-leaf (R67) too
    expect(isStringlyEqualDeep({ a: 5 }, { a: '5.0' })).toBe(true);
    // nested objects / arrays recurse
    expect(isStringlyEqualDeep({ a: { b: [80, 443] } }, { a: { b: ['80', '443'] } })).toBe(true);
    // a genuine value change still differs (real drift preserved)
    expect(isStringlyEqualDeep({ a: true }, { a: 'false' })).toBe(false);
    // an added/removed key is real drift — NOT folded
    expect(isStringlyEqualDeep({ a: '1', b: '2' }, { a: '1' })).toBe(false);
    expect(isStringlyEqualDeep({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    // disjoint-key object swap (WAFv2 DefaultAction) is not folded
    expect(isStringlyEqualDeep({ Allow: {} }, { Block: {} })).toBe(false);
    // array order still matters
    expect(isStringlyEqualDeep([80, 443], ['443', '80'])).toBe(false);
  });

  it('isAllAwsTags: every element an aws:* {Key,Value}', () => {
    expect(isAllAwsTags([{ Key: 'aws:cloudformation:stack-id', Value: 'x' }])).toBe(true);
    expect(
      isAllAwsTags([
        { Key: 'aws:x', Value: '1' },
        { Key: 'Team', Value: 'a' },
      ])
    ).toBe(false);
    expect(isAllAwsTags([])).toBe(false);
    expect(isAllAwsTags('nope')).toBe(false);
  });

  it('isAllAwsTags: map shape (SSM) where every key is aws:*', () => {
    expect(
      isAllAwsTags({ 'aws:cloudformation:stack-name': 'S', 'aws:cloudformation:logical-id': 'X' })
    ).toBe(true);
    expect(isAllAwsTags({ 'aws:x': '1', Team: 'a' })).toBe(false);
    expect(isAllAwsTags({})).toBe(false);
  });

  it('awsManagedTags: returns ONLY the aws:* {Key,Value} entries (inverse of stripAwsTagsDeep)', () => {
    expect(
      awsManagedTags([
        { Key: 'aws:cloudformation:stack-name', Value: 'S' },
        { Key: 'TestAddedTag', Value: 'AAA' },
        { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
      ])
    ).toEqual([
      { Key: 'aws:cloudformation:stack-name', Value: 'S' },
      { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
    ]);
    // no managed tags -> [], non-list -> [], empty -> []
    expect(awsManagedTags([{ Key: 'Team', Value: 'a' }])).toEqual([]);
    expect(awsManagedTags(undefined)).toEqual([]);
    expect(awsManagedTags('nope')).toEqual([]);
    expect(awsManagedTags([])).toEqual([]);
  });

  it('IAM Role known defaults present', () => {
    expect(KNOWN_DEFAULTS['AWS::IAM::Role'].MaxSessionDuration).toBe(3600);
  });

  it('EC2 Instance known defaults present — the 3 constant defaults a fresh instance reports (PR #310 follow-up)', () => {
    // Tenancy/SourceDestCheck/InstanceInitiatedShutdownBehavior are account-/
    // instance-independent constant defaults; the ec2-instance-rich corpus case
    // exercises the fold. Resource-specific live values (PrivateIpAddress,
    // SecurityGroups, CpuOptions, …) are deliberately NOT folded.
    expect(KNOWN_DEFAULTS['AWS::EC2::Instance']).toEqual({
      Tenancy: 'default',
      SourceDestCheck: true,
      InstanceInitiatedShutdownBehavior: 'stop',
    });
  });

  it('WarmPool + ECS CapacityProvider known defaults present (bug-hunt: ecs-capacityprovider-rich)', () => {
    // Constant service defaults a fresh ECS-on-EC2 deploy reports as first-run
    // undeclared inventory; equality-gated, so a value set away from the default
    // still surfaces. Exercised by the AWS__AutoScaling__WarmPool and
    // AWS__ECS__CapacityProvider corpus cases. Per-resource values (the WarmPool's
    // MaxGroupPreparedCapacity, the provider's ASG ARN) are deliberately NOT folded.
    expect(KNOWN_DEFAULTS['AWS::AutoScaling::WarmPool']).toEqual({ MinSize: 0 });
    expect(KNOWN_DEFAULT_PATHS['AWS::ECS::CapacityProvider']).toEqual({
      'AutoScalingGroupProvider.ManagedDraining': 'ENABLED',
    });
  });

  it('AppSync + Logs SubscriptionFilter known defaults present (bug-hunt: appsync-resolver-rich / logs-subscriptionfilter-rich)', () => {
    // Constant service defaults a fresh deploy reports as first-run undeclared
    // inventory; equality-gated, so a value set away from the default still surfaces.
    // Exercised by the AppSync Resolver/Function/GraphQLApi and SubscriptionFilter
    // corpus cases.
    expect(KNOWN_DEFAULTS['AWS::AppSync::Resolver']).toEqual({ MaxBatchSize: 0 });
    expect(KNOWN_DEFAULTS['AWS::AppSync::FunctionConfiguration']).toEqual({ MaxBatchSize: 0 });
    expect(KNOWN_DEFAULTS['AWS::AppSync::GraphQLApi'].QueryDepthLimit).toBe(0);
    expect(KNOWN_DEFAULTS['AWS::AppSync::GraphQLApi'].ResolverCountLimit).toBe(0);
    expect(KNOWN_DEFAULTS['AWS::Logs::SubscriptionFilter']).toEqual({
      Distribution: 'ByLogStream',
    });
  });

  it('ENI / DBProxy / CacheCluster known defaults present (bug-hunt: eni-rich / dbproxy-rich / elasticache-cachecluster-rich)', () => {
    // Constant, documented service defaults a fresh resource reports as first-run
    // undeclared inventory; equality-gated, so a value set away from the default still
    // surfaces. Exercised by the AWS__EC2__NetworkInterface / AWS__RDS__DBProxy /
    // AWS__ElastiCache__CacheCluster corpus cases. Resource-/AZ-/window-specific live
    // values (ENI PrivateIpAddress(es), CacheCluster Snapshot/MaintenanceWindow,
    // PreferredAvailabilityZones, the engine-version-derived CacheParameterGroupName)
    // are deliberately NOT folded — they are genuine undeclared inventory.
    expect(KNOWN_DEFAULTS['AWS::EC2::NetworkInterface']).toEqual({
      InterfaceType: 'interface',
      Ipv4PrefixCount: 0,
      Ipv6PrefixCount: 0,
      SecondaryPrivateIpAddressCount: 0,
      SourceDestCheck: true,
    });
    expect(KNOWN_DEFAULTS['AWS::ElastiCache::CacheCluster']).toEqual({
      NetworkType: 'ipv4',
      IpDiscovery: 'ipv4',
      AZMode: 'single-az',
      AutoMinorVersionUpgrade: true,
      SnapshotRetentionLimit: 0,
    });
    expect(KNOWN_DEFAULTS['AWS::MemoryDB::Cluster']).toEqual({
      Port: 6379,
      AutoMinorVersionUpgrade: true,
      DataTiering: 'false',
      NetworkType: 'ipv4',
      IpDiscovery: 'ipv4',
    });
    expect(KNOWN_DEFAULTS['AWS::Config::ConfigRule']).toEqual({
      EvaluationModes: [{ Mode: 'DETECTIVE' }],
    });
    expect(KNOWN_DEFAULTS['AWS::RDS::DBProxy']).toEqual({
      TargetConnectionNetworkType: 'IPV4',
      DefaultAuthScheme: 'NONE',
      EndpointNetworkType: 'IPV4',
    });
    expect(KNOWN_DEFAULTS['AWS::AmazonMQ::Broker']).toEqual({
      AuthenticationStrategy: 'SIMPLE',
      EncryptionOptions: { UseAwsOwnedKey: true },
      DataReplicationMode: 'NONE',
    });
  });

  it('first-run-noise folds from the measure-noise sweep (PR follow-up) — common-type constant defaults', () => {
    // Each value was OBSERVED unanimous across the golden corpus and is a genuine
    // constant service default; equality-gated, so a non-default value still surfaces.
    expect(KNOWN_DEFAULTS['AWS::SQS::Queue'].MaximumMessageSize).toBe(1048576);
    expect(KNOWN_DEFAULTS['AWS::Cognito::UserPoolClient'].RefreshTokenValidity).toBe(30);
    expect(KNOWN_DEFAULTS['AWS::ECS::Service'].HealthCheckGracePeriodSeconds).toBe(0);
    expect(KNOWN_DEFAULT_PATHS['AWS::ECS::Service']).toEqual({
      'DeploymentConfiguration.Strategy': 'ROLLING',
      'DeploymentConfiguration.BakeTimeInMinutes': 0,
      'DeploymentConfiguration.DeploymentCircuitBreaker.ResetOnHealthyTask': true,
      'DeploymentConfiguration.DeploymentCircuitBreaker.ThresholdConfiguration': {
        Type: 'BOUNDED_PERCENT',
        Value: 50,
      },
      'DeploymentConfiguration.DeploymentCircuitBreaker': {
        ThresholdConfiguration: { Type: 'BOUNDED_PERCENT', Value: 50 },
        Enable: false,
        ResetOnHealthyTask: true,
        Rollback: false,
      },
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::OpenSearchService::Domain']).toEqual({
      'EBSOptions.Iops': 3000,
      'EBSOptions.Throughput': 125,
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::KinesisFirehose::DeliveryStream']).toEqual({
      'ExtendedS3DestinationConfiguration.S3BackupMode': 'Disabled',
      'ExtendedS3DestinationConfiguration.CompressionFormat': 'UNCOMPRESSED',
      'ExtendedS3DestinationConfiguration.EncryptionConfiguration': {
        NoEncryptionConfig: 'NoEncryption',
      },
    });
  });

  it('DocDB + VolumeAttachment constant defaults (offline measure-noise sweep)', () => {
    // Each value was OBSERVED as undeclared first-run noise in the golden corpus and is a
    // genuine constant service default; equality-gated, so a non-default still surfaces.
    // DocumentDB's documented 1-day default backup retention (the DBCluster block also
    // carries the fixed Port 27017 asserted above).
    expect(KNOWN_DEFAULTS['AWS::DocDB::DBCluster'].BackupRetentionPeriod).toBe(1);
    // A DocDB instance reads back the same current default server CA as RDS::DBInstance.
    expect(KNOWN_DEFAULTS['AWS::DocDB::DBInstance']).toEqual({
      CACertificateIdentifier: 'rds-ca-rsa2048-g1',
    });
    expect(KNOWN_DEFAULTS['AWS::RDS::DBInstance'].CACertificateIdentifier).toBe(
      'rds-ca-rsa2048-g1'
    );
    // A standard single-card EBS attachment always reports card index 0.
    expect(KNOWN_DEFAULTS['AWS::EC2::VolumeAttachment']).toEqual({ EbsCardIndex: 0 });
  });

  it('Lambda EventSourceMapping stream retry/age + Enabled defaults (found by esm-sourceaccess-rich)', () => {
    // -1 is the documented "infinite" default for stream / Kafka event sources (retry
    // forever / no record-age cap); Enabled=true is the first-run default an omitting
    // construct reads back. All three live on the SINGLE EventSourceMapping entry —
    // #438 added Enabled as a SECOND object-literal key, which (JS last-key-wins) silently
    // dropped the retry/age fold; this asserts they coexist so that regression can't recur.
    // MaximumBatchingWindowInSeconds: 0 (the "no window" default) was later merged into the
    // SAME entry — asserted here so a future append can't re-introduce a duplicate key.
    expect(KNOWN_DEFAULTS['AWS::Lambda::EventSourceMapping']).toEqual({
      MaximumRetryAttempts: -1,
      MaximumRecordAgeInSeconds: -1,
      Enabled: true,
      MaximumBatchingWindowInSeconds: 0,
    });
  });

  it('PR #355-followup noise sweep: constant defaults on common daily-driver types', () => {
    // Each value was OBSERVED unanimous (>=2 cases) across the golden corpus and is a
    // documented constant service default — equality-gated, so a non-default value still
    // surfaces. Resource-/engine-/state-specific values were deliberately excluded.
    // Ports / fixed enums.
    expect(KNOWN_DEFAULTS['AWS::DocDB::DBCluster'].Port).toBe(27017);
    expect(KNOWN_DEFAULTS['AWS::Neptune::DBCluster'].DBPort).toBe(8182);
    expect(KNOWN_DEFAULTS['AWS::SQS::Queue'].KmsDataKeyReusePeriodSeconds).toBe(300);
    expect(KNOWN_DEFAULTS['AWS::RDS::DBCluster'].EngineMode).toBe('provisioned');
    expect(KNOWN_DEFAULTS['AWS::SSM::Association'].DocumentVersion).toBe('$DEFAULT');
    // AutoScaling.
    expect(KNOWN_DEFAULTS['AWS::AutoScaling::AutoScalingGroup']).toEqual({
      Cooldown: '300',
      HealthCheckType: 'EC2',
      HealthCheckGracePeriod: 0,
      TerminationPolicies: ['Default'],
      AvailabilityZoneDistribution: { CapacityDistributionStrategy: 'balanced-best-effort' },
      InstanceLifecyclePolicy: { RetentionTriggers: { TerminateHookAbandon: 'terminate' } },
      CapacityReservationSpecification: { CapacityReservationPreference: 'default' },
    });
    // CloudWatch alarms (Alarm.ActionsEnabled already folds via its schema default).
    expect(KNOWN_DEFAULTS['AWS::CloudWatch::Alarm'].TreatMissingData).toBe('missing');
    expect(KNOWN_DEFAULTS['AWS::CloudWatch::CompositeAlarm'].ActionsEnabled).toBe(true);
    expect(KNOWN_DEFAULTS['AWS::CloudWatch::MetricStream']).toEqual({
      IncludeLinkedAccountsMetrics: false,
      State: 'running',
    });
    // A WebACL reads back AWS's default on-source DDoS protection config when none is
    // declared (issue #440 — wafv2-webacl-customkeys live read).
    expect(KNOWN_DEFAULTS['AWS::WAFv2::WebACL']).toEqual({
      OnSourceDDoSProtectionConfig: { ALBLowReputationMode: 'ACTIVE_UNDER_DDOS' },
    });
    // KMS key defaults.
    expect(KNOWN_DEFAULTS['AWS::KMS::Key']).toEqual({
      Enabled: true,
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Origin: 'AWS_KMS',
    });
    // Boolean feature flags off by default on very common types.
    expect(KNOWN_DEFAULTS['AWS::DynamoDB::Table'].DeletionProtectionEnabled).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::Logs::LogGroup']).toEqual({
      LogGroupClass: 'STANDARD',
      DeletionProtectionEnabled: false,
      BearerTokenAuthenticationEnabled: false,
    });
    expect(KNOWN_DEFAULTS['AWS::EC2::VPC']).toEqual({
      InstanceTenancy: 'default',
      EnableDnsSupport: true,
    });
    expect(KNOWN_DEFAULTS['AWS::EC2::Subnet'].AssignIpv6AddressOnCreation).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::EC2::Subnet'].EnableDns64).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::EC2::Subnet'].Ipv6Native).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ApiGateway::Method'].ApiKeyRequired).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Route'].ApiKeyRequired).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ApiGateway::RestApi'].DisableExecuteApiEndpoint).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Api'].DisableExecuteApiEndpoint).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::AppSync::GraphQLApi'].XrayEnabled).toBe(false);
    expect(
      KNOWN_DEFAULTS['AWS::Cognito::UserPoolClient'].EnablePropagateAdditionalUserContextData
    ).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ECS::Service'].EnableExecuteCommand).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::ECS::Service'].DeploymentController).toEqual({ Type: 'ECS' });
    // AvailabilityZoneRebalancing has a NON-DETERMINISTIC default (ENABLED or DISABLED),
    // so it is folded value-independently, not via KNOWN_DEFAULTS.
    expect(
      VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::ECS::Service'].has(
        'AvailabilityZoneRebalancing'
      )
    ).toBe(true);
    expect(KNOWN_DEFAULTS['AWS::ElasticLoadBalancingV2::ListenerRule'].IsDefault).toBe(false);
    expect(KNOWN_DEFAULTS['AWS::Glue::Crawler'].LakeFormationConfiguration).toEqual({
      AccountId: '',
      UseLakeFormationCredentials: false,
    });
    // CloudWatch RUM AppMonitor (observed live on rum-appmonitor-rich): an undeclared
    // Platform reads back "Web", and undeclared source-map deobfuscation reads back the
    // disabled-state object. Equality-gated, so Android/iOS or an enabled config surfaces.
    expect(KNOWN_DEFAULTS['AWS::RUM::AppMonitor']).toEqual({
      Platform: 'Web',
      DeobfuscationConfiguration: { JavaScriptSourceMaps: { Status: 'DISABLED' } },
    });
  });

  it('Amazon Location first-run defaults fold on ALL five resource types', () => {
    // The deprecated `PricingPlan` parameter is echoed as the constant
    // "RequestBasedUsage" on EVERY Location resource, not just Tracker/GeofenceCollection
    // (the original #492 entries) — PlaceIndex/Map/RouteCalculator were an unguarded
    // allowlist gap surfaced live on location-rich (2026-07-07). A Tracker with no
    // PositionFiltering reads back "TimeBased", and a PlaceIndex with no
    // DataSourceConfiguration reads back {IntendedUse:"SingleUse"}. All equality-gated.
    for (const t of [
      'AWS::Location::Tracker',
      'AWS::Location::GeofenceCollection',
      'AWS::Location::PlaceIndex',
      'AWS::Location::Map',
      'AWS::Location::RouteCalculator',
    ]) {
      expect(KNOWN_DEFAULTS[t].PricingPlan).toBe('RequestBasedUsage');
    }
    expect(KNOWN_DEFAULTS['AWS::Location::Tracker'].PositionFiltering).toBe('TimeBased');
    expect(KNOWN_DEFAULTS['AWS::Location::PlaceIndex'].DataSourceConfiguration).toEqual({
      IntendedUse: 'SingleUse',
    });
  });

  it('EventBridge ApiDestination undeclared InvocationRateLimitPerSecond folds to the 300 default (bug-hunt: events-apidest-rich)', () => {
    // An ApiDestination that declares no InvocationRateLimitPerSecond reads back AWS's
    // constant default of 300 req/s (the documented default + maximum when omitted). It
    // surfaced as a first-run [Potential Drift] FP on a clean deploy until folded. Equality-
    // gated, so a user-set throttle or out-of-band change no longer matches 300 and re-
    // surfaces (proven live 2026-07-08; exercised end-to-end by the AWS__Events__
    // ApiDestination.ApiDestination corpus-replay case).
    expect(KNOWN_DEFAULTS['AWS::Events::ApiDestination']).toEqual({
      InvocationRateLimitPerSecond: 300,
    });
  });

  it('bug-hunt 2026-07-08 first-run constant/derived/value-independent folds (#619/#622/#625/#626/#628/#633)', () => {
    // Tier-1 equality-gated constants: undeclared values AWS materializes at creation that
    // surfaced as first-run [Potential Drift] FPs until folded (exercised end-to-end by the
    // matching corpus-replay cases). Equality-gated, so an out-of-band change re-surfaces.
    expect(KNOWN_DEFAULTS['AWS::EC2::VPNGateway']).toEqual({ AmazonSideAsn: 64512 }); // #619
    expect(KNOWN_DEFAULTS['AWS::Bedrock::Agent']?.IdleSessionTTLInSeconds).toBe(600); // #619
    expect(KNOWN_DEFAULTS['AWS::CodeGuruProfiler::ProfilingGroup']).toEqual({
      ComputePlatform: 'Default',
    }); // #622
    expect(KNOWN_DEFAULTS['AWS::ServiceCatalog::CloudFormationProduct']).toEqual({
      ProductType: 'CLOUD_FORMATION_TEMPLATE',
    }); // #625
    expect(KNOWN_DEFAULTS['AWS::InternetMonitor::Monitor']).toEqual({ Status: 'ACTIVE' }); // #626
    expect(KNOWN_DEFAULTS['AWS::RolesAnywhere::Profile']?.DurationSeconds).toBe(3600); // #619
    expect(KNOWN_DEFAULTS['AWS::RolesAnywhere::Profile']?.AttributeMappings).toEqual([
      { CertificateField: 'x509Issuer', MappingRules: [{ Specifier: '*' }] },
      {
        CertificateField: 'x509SAN',
        MappingRules: [{ Specifier: 'DNS' }, { Specifier: 'URI' }, { Specifier: 'Name/*' }],
      },
      { CertificateField: 'x509Subject', MappingRules: [{ Specifier: '*' }] },
    ]); // #619
    // Nested constant: a product's per-artifact Type echo.
    expect(KNOWN_DEFAULT_PATHS['AWS::ServiceCatalog::CloudFormationProduct']).toEqual({
      'ProvisioningArtifactParameters.*.Type': 'CLOUD_FORMATION_TEMPLATE',
    }); // #625
    // Tier-3 value-independent: per-resource AWS-assigned pointers/echoes the user cannot
    // meaningfully pin, folded only when UNDECLARED (a DECLARED value is compared).
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::Bedrock::AgentAlias']).toContain(
      'RoutingConfiguration'
    ); // #619
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::AppSync::ApiKey']).toContain('Expires'); // #619
    expect(
      VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::AppConfig::ExtensionAssociation']
    ).toContain('ExtensionVersionNumber'); // #622
    expect(
      VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::StepFunctions::StateMachineVersion']
    ).toContain('StateMachineRevisionId'); // #628
    expect(
      VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::StepFunctions::StateMachineAlias']
    ).toContain('StateMachineArn'); // #628
    // Value-independent nested generated id: the canary's AWS-assigned DeploymentId.
    expect(GENERATED_NESTED_PATHS['AWS::ApiGateway::Stage']).toContain(
      'CanarySetting.DeploymentId'
    ); // #633
  });

  it('VPCCidrBlock AmazonProvided ipv6 block + border group fold value-independent (#684)', () => {
    // A dual-stack / secondary-CIDR association that declares AmazonProvidedIpv6CidrBlock (no
    // explicit block) reads back the /56 AWS allocates plus its NetworkBorderGroup — both
    // AWS-assigned at creation, create-only, per-VPC. First-run [Potential Drift] FP on every
    // clean dual-stack VPC until folded (live-verified 2026-07-08, us-east-1: check went from
    // 2 potential drift to CLEAN). A user who brings their own CIDR DECLARES Ipv6CidrBlock,
    // which is then compared in the declared dimension (detection preserved).
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::EC2::VPCCidrBlock']).toContain(
      'Ipv6CidrBlock'
    ); // #684
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::EC2::VPCCidrBlock']).toContain(
      'Ipv6CidrBlockNetworkBorderGroup'
    ); // #684
  });

  it('ResourceExplorer2 View undeclared Scope folds via the context-ARN default (#626)', () => {
    // The account-root Scope is a tier-2 DERIVED default (arn:<partition>:iam::<account>:root),
    // built from the read context and equality-gated so a view scoped elsewhere still surfaces.
    // Exercised end-to-end by the AWS__ResourceExplorer2__View.RexView corpus-replay case.
    expect(CONTEXT_ARN_DEFAULTS['AWS::ResourceExplorer2::View']).toEqual({
      Scope: 'arn:{partition}:iam::{accountId}:root',
    });
  });

  it('KinesisVideo Stream/SignalingChannel first-run defaults fold (#624)', () => {
    // Tier-1 constants (auto-exercised by the generic KNOWN_DEFAULTS atDefault test + corpus).
    expect(KNOWN_DEFAULTS['AWS::KinesisVideo::Stream']).toEqual({ DataRetentionInHours: 0 });
    expect(KNOWN_DEFAULTS['AWS::KinesisVideo::SignalingChannel']).toEqual({
      Type: 'SINGLE_MASTER',
      MessageTtlSeconds: 60,
    });
    // The AWS-managed KMS key ARN is a tier-2 context-ARN derived default (a customer CMK still
    // surfaces, equality-gated); the whole-object StreamStorageConfiguration descends leaf-by-
    // leaf so its schema-`default` DefaultStorageTier=HOT folds (the #624 object-descend gap).
    expect(CONTEXT_ARN_DEFAULTS['AWS::KinesisVideo::Stream']).toEqual({
      KmsKeyId: 'arn:{partition}:kms:{region}:{accountId}:alias/aws/kinesisvideo',
    });
    expect(DESCEND_UNDECLARED_OBJECT_PATHS['AWS::KinesisVideo::Stream']).toContain(
      'StreamStorageConfiguration'
    );
  });

  it('common stateful/streaming-type constant defaults from the offline corpus sweep', () => {
    // Constant, documented service defaults common stateful/streaming types report as
    // first-run undeclared noise. Verified against the golden corpus (RDS DBInstance
    // values unanimous across 3 instances spanning aurora-mysql + mysql8.0) and
    // exercised by the corpus-replay cases. Equality-gated: a non-default value still
    // surfaces. Resource-/AZ-/window-/engine-derived values are deliberately excluded.
    expect(KNOWN_DEFAULTS['AWS::RDS::DBInstance']).toEqual({
      AutoMinorVersionUpgrade: true,
      BackupTarget: 'region',
      DatabaseInsightsMode: 'standard',
      // EngineLifecycleSupport moved to VALUE_INDEPENDENT (default varies by creation date).
      MonitoringInterval: 0,
      NetworkType: 'IPV4',
      StorageThroughput: 0,
      CopyTagsToSnapshot: false,
      DedicatedLogVolume: false,
      EnableIAMDatabaseAuthentication: false,
      EnablePerformanceInsights: false,
      ManageMasterUserPassword: false,
      MultiAZ: false,
      StorageEncrypted: false,
      // The current AWS default RDS server CA (constant; engine-derived RDS values fold via
      // ENGINE_DEFAULTS / DEFAULT_MANAGED_NAME_PATHS instead).
      CACertificateIdentifier: 'rds-ca-rsa2048-g1',
    });
    expect(KNOWN_DEFAULTS['AWS::RDS::DBCluster'].NetworkType).toBe('IPV4');
    expect(KNOWN_DEFAULTS['AWS::ElastiCache::ReplicationGroup']).toEqual({
      AutoMinorVersionUpgrade: true,
      ClusterMode: 'disabled',
      IpDiscovery: 'ipv4',
      NetworkType: 'ipv4',
      ReplicasPerNodeGroup: 0,
    });
    expect(KNOWN_DEFAULTS['AWS::Neptune::DBInstance'].AutoMinorVersionUpgrade).toBe(true);
    expect(KNOWN_DEFAULTS['AWS::EC2::VPCEndpoint'].IpAddressType).toBe('ipv4');
    expect(KNOWN_DEFAULTS['AWS::EC2::TransitGateway'].SecurityGroupReferencingSupport).toBe(
      'disable'
    );
    expect(KNOWN_DEFAULTS['AWS::EC2::FlowLog'].MaxAggregationInterval).toBe(600);
    expect(KNOWN_DEFAULTS['AWS::EC2::PlacementGroup']).toEqual({ SpreadLevel: 'rack' });
    expect(KNOWN_DEFAULTS['AWS::EC2::IPAM']).toEqual({ MeteredAccount: 'ipam-owner' });
    expect(KNOWN_DEFAULTS['AWS::APS::Workspace']).toEqual({
      WorkspaceConfiguration: {
        RuleQueryOffsetInSeconds: 60,
        RetentionPeriodInDays: 150,
        OutOfOrderTimeWindowInSeconds: 60,
        LimitsPerLabelSets: [],
      },
    });
    expect(KNOWN_DEFAULTS['AWS::Pipes::Pipe'].DesiredState).toBe('RUNNING');
    expect(KNOWN_DEFAULTS['AWS::Synthetics::Canary']).toEqual({
      FailureRetentionPeriod: 31,
      SuccessRetentionPeriod: 31,
      ProvisionedResourceCleanup: 'AUTOMATIC',
      RunConfig: {
        TimeoutInSeconds: 840,
        MemoryInMB: 1500,
        EphemeralStorage: 1024,
        ActiveTracing: false,
      },
    });
    expect(KNOWN_DEFAULTS['AWS::MSK::Cluster']).toEqual({
      EnhancedMonitoring: 'DEFAULT',
      StorageMode: 'LOCAL',
    });
    expect(KNOWN_DEFAULTS['AWS::OpenSearchService::Domain'].IPAddressType).toBe('ipv4');
    expect(KNOWN_DEFAULTS['AWS::Glue::Job']).toEqual({
      JobMode: 'SCRIPT',
      MaxRetries: 0,
      Timeout: 2880,
      ExecutionProperty: { MaxConcurrentRuns: 1 },
    });
    // nested
    expect(KNOWN_DEFAULT_PATHS['AWS::WAFv2::WebACL']).toEqual({
      'Rules.*.Statement.RateBasedStatement.EvaluationWindowSec': 300,
    });
    // A RuleGroup hosts the same rate-based statement, so it carries the identical
    // 5-minute window default (issue #440 — wafv2-ratecustomkeys live read).
    expect(KNOWN_DEFAULT_PATHS['AWS::WAFv2::RuleGroup']).toEqual({
      'Rules.*.Statement.RateBasedStatement.EvaluationWindowSec': 300,
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::SES::EmailIdentity']).toEqual({
      'MailFromAttributes.BehaviorOnMxFailure': 'USE_DEFAULT_VALUE',
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::Batch::JobDefinition']).toEqual({
      'ContainerProperties.RuntimePlatform.CpuArchitecture': 'X86_64',
      'ContainerProperties.RuntimePlatform.OperatingSystemFamily': 'LINUX',
      'ContainerProperties.FargatePlatformConfiguration.PlatformVersion': 'LATEST',
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::CodeBuild::Project']['Artifacts.Packaging']).toBe('NONE');
  });

  it('S3 suspended versioning is a known default — the off state a revert lands on (R46)', () => {
    expect(KNOWN_DEFAULTS['AWS::S3::Bucket'].VersioningConfiguration).toEqual({
      Status: 'Suspended',
    });
  });

  it('stripAwsTagsDeep removes aws:* tags (list + map), keeps the rest', () => {
    expect(
      stripAwsTagsDeep([
        { Key: 'aws:cloudformation:stack-name', Value: 'S' },
        { Key: 'aws-cdk:x', Value: 'y' },
      ])
    ).toEqual([{ Key: 'aws-cdk:x', Value: 'y' }]);
    expect(stripAwsTagsDeep({ Tags: { 'aws:cf': '1', Team: 'a' } })).toEqual({
      Tags: { Team: 'a' },
    });
  });

  it('stripAwsTagsDeep NEVER touches aws:* keys outside a Tags map — IAM condition keys survive (R69)', () => {
    // the CDK enforceSSL pattern: Condition.Bool["aws:SecureTransport"] is a
    // policy CONDITION KEY, not a tag — the old strip-anywhere rule deleted it
    // from the live side and produced desired-vs-undefined false drift.
    const stmt = {
      Effect: 'Deny',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      StringEquals: { 'aws:PrincipalOrgID': 'o-corpus123' },
    };
    expect(stripAwsTagsDeep(stmt)).toEqual(stmt);
    // a map under Tags nested deeper still strips
    expect(stripAwsTagsDeep({ Nested: { Tags: { 'aws:cf': '1', Team: 'a' } } })).toEqual({
      Nested: { Tags: { Team: 'a' } },
    });
  });

  it('isPemEqual: trailing-newline / CRLF differences on a PEM block are not drift (R125)', () => {
    const key = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqAQAB\n-----END PUBLIC KEY-----';
    // CloudFront PublicKey EncodedKey: AWS appends a trailing newline on read
    expect(isPemEqual(key, `${key}\n`)).toBe(true);
    expect(isPemEqual(`  ${key}\n\n`, key)).toBe(true); // surrounding whitespace
    expect(isPemEqual(key.replace(/\n/g, '\r\n'), key)).toBe(true); // CRLF normalize
    // a genuinely different key body still differs (fail-closed)
    const other = '-----BEGIN PUBLIC KEY-----\nMIIBIjANDIFFERENT\n-----END PUBLIC KEY-----';
    expect(isPemEqual(key, other)).toBe(false);
    // both sides must be PEM-armored — a plain string is never folded
    expect(isPemEqual('hello\n', 'hello')).toBe(false);
    expect(isPemEqual(key, 'hello')).toBe(false);
    // non-strings never match
    expect(isPemEqual(1, 1)).toBe(false);
  });

  it('isSshPublicKeyEqual: EC2 rewrites the comment to the key name + appends a newline — same material is not drift', () => {
    // Observed live (misc-0cov-rich): an imported KeyPair reads PublicKeyMaterial
    // back with the comment replaced by the KeyName and a trailing newline.
    const declared =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPRfhD3vb5rmS6P4rVU65OFl8aLIHppMwCNy0+r49tT cdkrd-hunt';
    const live =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPRfhD3vb5rmS6P4rVU65OFl8aLIHppMwCNy0+r49tT cdkrd-hunt-keypair\n';
    expect(isSshPublicKeyEqual(declared, live)).toBe(true);
    // comment entirely absent on one side still folds
    expect(
      isSshPublicKeyEqual('ssh-rsa AAAAB3Nza+/x== me@laptop', 'ssh-rsa AAAAB3Nza+/x==\n')
    ).toBe(true);
    // sk-/ecdsa key types parse too
    expect(
      isSshPublicKeyEqual(
        'sk-ssh-ed25519@openssh.com AAAAGnNr me@laptop',
        'sk-ssh-ed25519@openssh.com AAAAGnNr imported-key\n'
      )
    ).toBe(true);
    // a genuinely different key blob still differs (fail-closed)
    expect(isSshPublicKeyEqual(declared, declared.replace('IJPRfhD3', 'IDIFFRNT'))).toBe(false);
    // a different key TYPE still differs
    expect(isSshPublicKeyEqual('ssh-ed25519 AAAAC3 c', 'ssh-rsa AAAAC3 c')).toBe(false);
    // both sides must parse as OpenSSH public keys — arbitrary strings never fold
    expect(isSshPublicKeyEqual('hello world', 'hello world\n')).toBe(false);
    expect(isSshPublicKeyEqual(declared, 'not-a-key')).toBe(false);
    // non-strings never match
    expect(isSshPublicKeyEqual(1, 1)).toBe(false);
    // the KeyPair path is registered
    expect(SSH_PUBLIC_KEY_PATHS['AWS::EC2::KeyPair']?.has('PublicKeyMaterial')).toBe(true);
  });

  it('CASE_INSENSITIVE_PATHS: EMR Serverless Application Type is folded case-insensitively', () => {
    // Observed live (misc-0cov-rich): declared "SPARK" reads back "Spark".
    expect(CASE_INSENSITIVE_PATHS['AWS::EMRServerless::Application']?.has('Type')).toBe(true);
  });

  it('CASE_INSENSITIVE_PATHS: DMS Endpoint EndpointType is folded case-insensitively', () => {
    // Observed live (#500 reader live-test): declared "source" reads back "SOURCE".
    expect(CASE_INSENSITIVE_PATHS['AWS::DMS::Endpoint']?.has('EndpointType')).toBe(true);
  });

  it('KNOWN_DEFAULTS: misc-0cov-rich first-run service defaults are registered', () => {
    // Observed live (misc-0cov-rich): constant service defaults a fresh resource
    // reads back without declaring them.
    expect(KNOWN_DEFAULTS['AWS::FIS::ExperimentTemplate']).toEqual({
      ExperimentOptions: {
        EmptyTargetResolutionMode: 'fail',
        AccountTargeting: 'single-account',
      },
    });
    expect(KNOWN_DEFAULTS['AWS::VerifiedPermissions::PolicyStore']).toEqual({
      DeletionProtection: { Mode: 'DISABLED' },
      Schema: { CedarJson: '{}' },
    });
    expect(KNOWN_DEFAULTS['AWS::Cassandra::Keyspace']).toEqual({
      ReplicationSpecification: { ReplicationStrategy: 'SINGLE_REGION' },
    });
    expect(KNOWN_DEFAULTS['AWS::Cassandra::Table']).toEqual({
      WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      EncryptionSpecification: { EncryptionType: 'AWS_OWNED_KMS_KEY' },
      CdcSpecification: { Status: 'DISABLED' },
    });
    expect(KNOWN_DEFAULTS['AWS::EMRServerless::Application']).toEqual({
      Architecture: 'X86_64',
      MonitoringConfiguration: {
        ManagedPersistenceMonitoringConfiguration: { Enabled: true },
      },
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::EMRServerless::Application']).toEqual({
      'MaximumCapacity.Disk': '400000 GB',
    });
    // amplify-codeconnections-rich first-run defaults
    expect(KNOWN_DEFAULTS['AWS::Amplify::App']).toEqual({
      JobConfig: { BuildComputeType: 'STANDARD_8GB' },
      CacheConfig: { Type: 'AMPLIFY_MANAGED_NO_COOKIES' },
    });
    // the all-zeros "no host" sentinel ARN AWS echoes for cloud-provider connections
    expect(KNOWN_DEFAULTS['AWS::CodeStarConnections::Connection']).toEqual({
      HostArn:
        'arn:aws:codestar-connections:us-west-2:000000000000:host/00000000-0000-0000-0000-000000000000',
    });
  });

  it('AppRunner + Transfer first-run defaults (bug-hunt: apprunner-service-rich / transfer-server-rich)', () => {
    // Constant AWS-assigned first-run defaults a fresh service/server reads back
    // without declaring them; equality-gated (subset-tolerant for the objects), so a
    // value set away from the default still surfaces. Exercised live and by the
    // AWS__AppRunner__Service / AWS__Transfer__Server corpus cases.
    // An App Runner service that declares neither knob reads back the TCP health check
    // and the public IPV4 DEFAULT-egress network.
    expect(KNOWN_DEFAULTS['AWS::AppRunner::Service']).toEqual({
      HealthCheckConfiguration: {
        Protocol: 'TCP',
        Path: '/',
        Interval: 5,
        Timeout: 2,
        HealthyThreshold: 1,
        UnhealthyThreshold: 5,
      },
      NetworkConfiguration: {
        IpAddressType: 'IPV4',
        EgressConfiguration: { EgressType: 'DEFAULT' },
        IngressConfiguration: { IsPubliclyAccessible: true },
      },
    });
    // A Transfer server assigns the stable default security policy, an S3 domain, and
    // directory-listing optimization DISABLED when those are omitted.
    expect(KNOWN_DEFAULTS['AWS::Transfer::Server']).toEqual({
      IpAddressType: 'IPV4',
      ProtocolDetails: {
        PassiveIp: 'AUTO',
        SetStatOption: 'DEFAULT',
        TlsSessionResumptionMode: 'ENFORCED',
      },
      SecurityPolicyName: 'TransferSecurityPolicy-2018-11',
      Domain: 'S3',
      S3StorageOptions: { DirectoryListingOptimization: 'DISABLED' },
    });
  });

  it('ApplicationSignals SLO Goal first-run default (bug-hunt: slo-notif-rich)', () => {
    // A period-based SLO that omits `Goal` reads it back fully materialized with
    // AWS's constant default (rolling 7-day interval, AttainmentGoal 99,
    // WarningThreshold 50) — a whole nested object the CFn schema does NOT annotate
    // as `default`. Equality-gated whole-object, so an out-of-band change to any
    // sub-field (a different AttainmentGoal, a calendar interval) no longer matches
    // and re-surfaces. Exercised live and by the
    // AWS__ApplicationSignals__ServiceLevelObjective corpus case.
    expect(KNOWN_DEFAULTS['AWS::ApplicationSignals::ServiceLevelObjective']).toEqual({
      Goal: {
        WarningThreshold: 50,
        AttainmentGoal: 99,
        Interval: { RollingInterval: { DurationUnit: 'DAY', Duration: 7 } },
      },
    });
    const goalDef = KNOWN_DEFAULTS['AWS::ApplicationSignals::ServiceLevelObjective']!.Goal;
    // Folds the exact default...
    expect(
      matchesKnownDefault(
        {
          WarningThreshold: 50,
          AttainmentGoal: 99,
          Interval: { RollingInterval: { DurationUnit: 'DAY', Duration: 7 } },
        },
        goalDef
      )
    ).toBe(true);
    // ...but an out-of-band change to AttainmentGoal still surfaces (detection kept).
    expect(
      matchesKnownDefault(
        {
          WarningThreshold: 50,
          AttainmentGoal: 95,
          Interval: { RollingInterval: { DurationUnit: 'DAY', Duration: 7 } },
        },
        goalDef
      )
    ).toBe(false);
    // ...and a calendar interval (a real, user-meaningful choice) surfaces too.
    expect(
      matchesKnownDefault(
        {
          WarningThreshold: 50,
          AttainmentGoal: 99,
          Interval: { CalendarInterval: { DurationUnit: 'MONTH', Duration: 1 } },
        },
        goalDef
      )
    ).toBe(false);
  });

  it('isCfnTemplateNonAsciiMask: GetTemplate `?`-masked non-ASCII declared value is not drift', () => {
    // GetTemplate returns the deployed template with every non-ASCII char as `?`
    // (one per codepoint). The declared side is corrupted; the live side is intact.
    expect(isCfnTemplateNonAsciiMask('?????ABC', 'áéíóúABC')).toBe(true); // 5 non-ASCII chars
    expect(isCfnTemplateNonAsciiMask('???', 'áéí')).toBe(true);
    expect(isCfnTemplateNonAsciiMask('1????', '1áéíó')).toBe(true); // ASCII prefix kept
    expect(isCfnTemplateNonAsciiMask('?????', 'áéíóú')).toBe(true);
    // a genuine ASCII change still differs (declared masks `?` only where live is non-ASCII)
    expect(isCfnTemplateNonAsciiMask('?????ABC', 'áéíóúBC')).toBe(false); // dropped a char
    expect(isCfnTemplateNonAsciiMask('?????XBC', 'áéíóúABC')).toBe(false); // ASCII differs
    // a length change still differs (declared longer/shorter than live mask)
    expect(isCfnTemplateNonAsciiMask('????', 'áéí')).toBe(false); // 4 vs 3 codepoints
    // the declared side must carry at least one `?` AND the live side at least one non-ASCII
    expect(isCfnTemplateNonAsciiMask('plain', 'plain')).toBe(false);
    expect(isCfnTemplateNonAsciiMask('abc', 'abc')).toBe(false);
    // a declared LITERAL `?` against an all-ASCII live value is never folded (no non-ASCII)
    expect(isCfnTemplateNonAsciiMask('a?c', 'abc')).toBe(false);
    // non-strings never match
    expect(isCfnTemplateNonAsciiMask(1, 1)).toBe(false);
    expect(isCfnTemplateNonAsciiMask('?', undefined)).toBe(false);
  });
});

describe('#649 DynamoDB first-run FPs: ContributorInsights Mode + SSE type/KMS echoes', () => {
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
  const bare = (resourceType: string, declared: Record<string, unknown> = {}): DesiredResource => ({
    logicalId: 'Tbl',
    resourceType,
    physicalId: 'my-table-phys',
    declared,
  });
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ): { atDefault: string[]; generated: string[]; undeclared: string[] } => {
    const findings: Finding[] = classifyResource(bare(resourceType, declared), live, emptySchema);
    const by = (tier: string) =>
      findings
        .filter((f) => f.tier === tier)
        .map((f) => f.path)
        .sort();
    return { atDefault: by('atDefault'), generated: by('generated'), undeclared: by('undeclared') };
  };
  // The account's AWS-managed aws/dynamodb key ARN AWS echoes into SSESpecification.KMSMasterKeyId.
  const accountKmsArn =
    'arn:aws:kms:us-east-1:111122223333:key/e6ab85f6-1234-5678-9abc-def012345678';

  it('table shapes: Mode/SSEType are equality-gated KNOWN_DEFAULT_PATHS, KMSMasterKeyId is value-independent', () => {
    expect(
      KNOWN_DEFAULT_PATHS['AWS::DynamoDB::Table']['ContributorInsightsSpecification.Mode']
    ).toBe('ACCESSED_AND_THROTTLED_KEYS');
    expect(
      KNOWN_DEFAULT_PATHS['AWS::DynamoDB::Table'][
        'GlobalSecondaryIndexes.*.ContributorInsightsSpecification.Mode'
      ]
    ).toBe('ACCESSED_AND_THROTTLED_KEYS');
    expect(KNOWN_DEFAULT_PATHS['AWS::DynamoDB::Table']['SSESpecification.SSEType']).toBe('KMS');
    expect(
      GENERATED_NESTED_PATHS['AWS::DynamoDB::Table'].has('SSESpecification.KMSMasterKeyId')
    ).toBe(true);
    // GlobalTable twin (#523): SSEType top-level, CI per-replica + per-replica-GSI, KMS per-replica.
    expect(KNOWN_DEFAULT_PATHS['AWS::DynamoDB::GlobalTable']['SSESpecification.SSEType']).toBe(
      'KMS'
    );
    expect(
      KNOWN_DEFAULT_PATHS['AWS::DynamoDB::GlobalTable'][
        'Replicas.*.ContributorInsightsSpecification.Mode'
      ]
    ).toBe('ACCESSED_AND_THROTTLED_KEYS');
    expect(
      KNOWN_DEFAULT_PATHS['AWS::DynamoDB::GlobalTable'][
        'Replicas.*.GlobalSecondaryIndexes.*.ContributorInsightsSpecification.Mode'
      ]
    ).toBe('ACCESSED_AND_THROTTLED_KEYS');
    expect(
      GENERATED_NESTED_PATHS['AWS::DynamoDB::GlobalTable'].has(
        'Replicas.*.SSESpecification.KMSMasterKeyId'
      )
    ).toBe(true);
  });

  it('classic Table: a clean table with the declared flags surfaces ZERO undeclared drift', () => {
    // The user DECLARED ContributorInsightsSpecification.Enabled + SSESpecification.SSEEnabled;
    // AWS echoes the undeclared Mode / SSEType / KMSMasterKeyId siblings. All three must fold.
    const r = t(
      'AWS::DynamoDB::Table',
      {
        ContributorInsightsSpecification: { Enabled: true },
        SSESpecification: { SSEEnabled: true },
      },
      {
        ContributorInsightsSpecification: { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' },
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: accountKmsArn },
      }
    );
    expect(r.undeclared).toEqual([]);
    expect(r.atDefault).toContain('ContributorInsightsSpecification.Mode');
    expect(r.atDefault).toContain('SSESpecification.SSEType');
    expect(r.generated).toContain('SSESpecification.KMSMasterKeyId');
  });

  it('classic Table: a GSI-nested ContributorInsights Mode default folds too', () => {
    // GSIs are keyed by IndexName (IDENTITY_FIELDS), so the undeclared descent aligns the
    // declared GSI to the live one and reports the finding path identity-keyed
    // (GlobalSecondaryIndexes[gsi1]…), where the `.*` fold key matches.
    const r = t(
      'AWS::DynamoDB::Table',
      {
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', ContributorInsightsSpecification: { Enabled: true } },
        ],
      },
      {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            ContributorInsightsSpecification: {
              Enabled: true,
              Mode: 'ACCESSED_AND_THROTTLED_KEYS',
            },
          },
        ],
      }
    );
    const gsiModePath = 'GlobalSecondaryIndexes[gsi1].ContributorInsightsSpecification.Mode';
    expect(r.undeclared).not.toContain(gsiModePath);
    expect(r.atDefault).toContain(gsiModePath);
  });

  it('detection preserved: a CHANGED Mode / SSEType still surfaces (equality-gated)', () => {
    // ContributorInsights Mode flipped to the other enum value out of band → real undeclared drift.
    const changedMode = t(
      'AWS::DynamoDB::Table',
      { ContributorInsightsSpecification: { Enabled: true } },
      { ContributorInsightsSpecification: { Enabled: true, Mode: 'THROTTLED_KEYS' } }
    );
    expect(changedMode.undeclared).toContain('ContributorInsightsSpecification.Mode');
    expect(changedMode.atDefault).not.toContain('ContributorInsightsSpecification.Mode');
    // A hypothetical non-KMS SSEType would also surface (only 'KMS' folds).
    const changedType = t(
      'AWS::DynamoDB::Table',
      { SSESpecification: { SSEEnabled: true } },
      { SSESpecification: { SSEEnabled: true, SSEType: 'SOMETHING_ELSE' } }
    );
    expect(changedType.undeclared).toContain('SSESpecification.SSEType');
    expect(changedType.atDefault).not.toContain('SSESpecification.SSEType');
  });

  it('a user-DECLARED KMSMasterKeyId is compared in the declared dimension (detection preserved)', () => {
    // Declaring a customer-managed key sends KMSMasterKeyId through the DECLARED loop, so an
    // out-of-band swap to a DIFFERENT key surfaces as declared drift — the value-independent
    // undeclared fold only applies when the key is UNDECLARED (delegated to AWS).
    const findings = classifyResource(
      bare('AWS::DynamoDB::Table', {
        SSESpecification: { SSEEnabled: true, KMSMasterKeyId: 'alias/my-key' },
      }),
      { SSESpecification: { SSEEnabled: true, KMSMasterKeyId: 'alias/attacker-key' } },
      emptySchema
    );
    const declared = findings.filter((f) => f.tier === 'declared').map((f) => f.path);
    expect(declared).toContain('SSESpecification.KMSMasterKeyId');
  });

  it('GlobalTable twin: top-level SSEType default folds clean, a changed type surfaces', () => {
    // GlobalTable's SSESpecification is top-level (SSEEnabled/SSEType), so this end-to-end
    // fold is reachable today. (The per-replica Mode/KMSMasterKeyId noise-side folds are
    // asserted structurally in the shapes test above; their undeclared descent additionally
    // needs the `Replicas` array keyed by Region in NESTED_ARRAY_IDENTITY, which lives in
    // classify.ts and is out of scope for this noise-only change.)
    const clean = t(
      'AWS::DynamoDB::GlobalTable',
      { SSESpecification: { SSEEnabled: true } },
      { SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } }
    );
    expect(clean.atDefault).toContain('SSESpecification.SSEType');
    expect(clean.undeclared).not.toContain('SSESpecification.SSEType');
    const changed = t(
      'AWS::DynamoDB::GlobalTable',
      { SSESpecification: { SSEEnabled: true } },
      { SSESpecification: { SSEEnabled: true, SSEType: 'SOMETHING_ELSE' } }
    );
    expect(changed.undeclared).toContain('SSESpecification.SSEType');
    expect(changed.atDefault).not.toContain('SSESpecification.SSEType');
  });
});

describe('cc-api strip', () => {
  it('removes managed fields at any depth, keeps the rest', () => {
    const out = stripCcApiAwsManagedFields({
      Name: 'n',
      Arn: 'a',
      CreationDate: 't',
      Nested: { LastModifiedTime: 't', Keep: 1 },
    });
    expect(out).toEqual({ Name: 'n', Arn: 'a', Nested: { Keep: 1 } }); // Arn intentionally kept
  });

  it('does NOT strip a managed-LOOKING key inside a free-form user map (the FN fix)', () => {
    // a Lambda env var / Glue Parameter / user Tag keyed like a managed field is USER
    // data — stripping it would hide a real out-of-band change. The genuine top-level
    // managed field is still stripped.
    const out = stripCcApiAwsManagedFields({
      LastModified: '2026-06-16T00:00:00Z', // genuine top-level managed field -> stripped
      Environment: { Variables: { APP_VERSION: 'v2', LastModified: 'user-set' } },
      Parameters: { OwnerId: 'team-a' }, // Glue-style free-form map -> kept
      Tags: { CreatedBy: 'alice' }, // map-shaped user tag -> kept
    });
    expect(out).toEqual({
      Environment: { Variables: { APP_VERSION: 'v2', LastModified: 'user-set' } },
      Parameters: { OwnerId: 'team-a' },
      Tags: { CreatedBy: 'alice' },
    });
  });

  it('protects a NESTED object value under a free-form map (sticky free-form, WAVE24)', () => {
    // a user key colliding with a managed name, an OBJECT-level deeper inside a free-form
    // map, must NOT be stripped — the protection is now sticky down the subtree.
    const out = stripCcApiAwsManagedFields({
      Parameters: { group: { OwnerId: 'team', CreatedBy: 'alice' } }, // nested user data -> kept
      Variables: { config: { LastModified: 'user-set', nested: { CreatedAt: 'x' } } },
    });
    expect(out).toEqual({
      Parameters: { group: { OwnerId: 'team', CreatedBy: 'alice' } },
      Variables: { config: { LastModified: 'user-set', nested: { CreatedAt: 'x' } } },
    });
  });

  it('STILL strips a genuine nested managed field in a STRUCTURED object (no FP regression)', () => {
    // StepFunctions LoggingConfiguration.CreatedAt is AWS-managed and NOT under a
    // free-form-map key, so it is still removed.
    const out = stripCcApiAwsManagedFields({
      LoggingConfiguration: { Level: 'OFF', CreatedAt: '2026-06-16T00:00:00Z' },
    });
    expect(out).toEqual({ LoggingConfiguration: { Level: 'OFF' } });
  });

  it('drops bare null array-element husks (S3 TagFilters:[null], #641)', () => {
    // S3 echoes `TagFilters: [null]` inside every prefix-scoped IntelligentTiering /
    // Metrics config element that declares no tag filter — a service read artifact, not
    // a user value. The null husk is dropped so it never surfaces as first-run undeclared
    // drift; a REAL out-of-band edit produces non-null objects, which are preserved.
    const out = stripCcApiAwsManagedFields({
      IntelligentTieringConfigurations: [{ Id: 'dataTier', Prefix: 'data/', TagFilters: [null] }],
      MetricsConfigurations: [
        { Id: 'EntireBucket' },
        { Id: 'LogsOnly', Prefix: 'logs/', TagFilters: [null] },
      ],
    });
    expect(out).toEqual({
      IntelligentTieringConfigurations: [{ Id: 'dataTier', Prefix: 'data/', TagFilters: [] }],
      MetricsConfigurations: [
        { Id: 'EntireBucket' },
        { Id: 'LogsOnly', Prefix: 'logs/', TagFilters: [] },
      ],
    });
  });

  it('keeps a real (non-null) array element, dropping only the null husk', () => {
    // a genuine out-of-band TagFilter is a non-null object and must keep surfacing —
    // only the interleaved null artifact is removed.
    const out = stripCcApiAwsManagedFields({
      TagFilters: [{ Key: 'team', Value: 'a' }, null],
    });
    expect(out).toEqual({ TagFilters: [{ Key: 'team', Value: 'a' }] });
  });

  it('does NOT drop null array elements under a free-form USER map (user data preserved)', () => {
    // inside a free-form map the array is the user's own data; a null there is the user's,
    // not a service artifact, so it is left verbatim (consistent with the sticky free-form guard).
    const out = stripCcApiAwsManagedFields({
      Environment: { Variables: { list: [null, 'v'] } },
    });
    expect(out).toEqual({ Environment: { Variables: { list: [null, 'v'] } } });
  });
});

describe('parseSchema', () => {
  it('reduces JSON-pointer paths to top-level names + extracts defaults', () => {
    const info = parseSchema(
      JSON.stringify({
        readOnlyProperties: ['/properties/Arn', '/properties/Lifecycle/Rules/*/X'],
        writeOnlyProperties: ['/properties/AccessControl'],
        properties: { Path: { default: '/' }, Name: {} },
      })
    );
    expect([...info.readOnly]).toEqual(['Arn']); // nested path NOT promoted to top-level
    expect(info.readOnlyPaths).toContain('Lifecycle.Rules.*.X');
    expect([...info.writeOnly]).toEqual(['AccessControl']);
    expect(info.defaults).toEqual({ Path: '/' });
  });

  it('injectReaderGaps appends SDK-reader-unreadable nested paths as writeOnly strips (AnomalyDetector Label)', () => {
    // DescribeAnomalyDetectors never echoes a metric-math query's cosmetic Label, so a
    // declared label would false-flag as declared drift against the override reader's
    // live model — the gap path strips it from BOTH sides (readGap semantics).
    const raw = parseSchema(JSON.stringify({ properties: { Namespace: { type: 'string' } } }));
    const info = injectReaderGaps(raw, 'AWS::CloudWatch::AnomalyDetector');
    expect(info.writeOnlyPaths).toContain('MetricMathAnomalyDetector.MetricDataQueries.*.Label');
    // a type with no reader gaps is returned untouched
    expect(injectReaderGaps(raw, 'AWS::S3::Bucket')).toBe(raw);
    expect(SDK_READER_GAP_PATHS['AWS::CloudWatch::AnomalyDetector']).toEqual([
      'MetricMathAnomalyDetector.MetricDataQueries.*.Label',
    ]);
  });

  it('supplementReadOnly patches a schema-forgotten readOnly gap (NetworkManager GlobalNetwork State/CreatedAt)', () => {
    // GlobalNetwork's registry schema marks only [Id, Arn] readOnly and forgets its lifecycle
    // State (AVAILABLE/UPDATING/DELETING) + CreatedAt — provably an AWS oversight (the sibling
    // Site marks the same pair readOnly, #495). The supplement folds them into readOnly so a
    // live model carrying State: "AVAILABLE" is stripped for every tier.
    const raw = parseSchema(
      JSON.stringify({
        readOnlyProperties: ['/properties/Id', '/properties/Arn'],
        properties: {
          State: { type: 'string' },
          CreatedAt: { type: 'string' },
          Description: { type: 'string' },
        },
      })
    );
    // Before the supplement: schema has only Id/Arn readOnly; State/CreatedAt leak.
    expect([...raw.readOnly].sort()).toEqual(['Arn', 'Id']);
    expect(raw.readOnly.has('State')).toBe(false);
    expect(raw.readOnly.has('CreatedAt')).toBe(false);

    const info = supplementReadOnly(raw, 'AWS::NetworkManager::GlobalNetwork');
    // After: both lifecycle attrs are readOnly (top-level set) AND readOnlyPaths (nested strip).
    expect([...info.readOnly].sort()).toEqual(['Arn', 'CreatedAt', 'Id', 'State']);
    expect(info.readOnlyPaths).toContain('State');
    expect(info.readOnlyPaths).toContain('CreatedAt');
    // Idempotent-ish: does not duplicate a path already present.
    expect(info.readOnlyPaths.filter((p) => p === 'State')).toHaveLength(1);
    // A type with no supplement is returned untouched.
    expect(supplementReadOnly(raw, 'AWS::S3::Bucket')).toBe(raw);
    expect(SCHEMA_READONLY_SUPPLEMENTS['AWS::NetworkManager::GlobalNetwork']).toEqual([
      '/properties/State',
      '/properties/CreatedAt',
    ]);
  });

  it('exemptOverrideReadable un-marks a writeOnly prop an SDK override can read (EC2 LaunchTemplate)', () => {
    // EC2 LaunchTemplate: LaunchTemplateData/VersionDescription/TagSpecifications are all
    // writeOnly, but the readEc2LaunchTemplate override reads LaunchTemplateData back.
    const raw = parseSchema(
      JSON.stringify({
        writeOnlyProperties: [
          '/properties/LaunchTemplateData',
          '/properties/VersionDescription',
          '/properties/TagSpecifications',
        ],
      })
    );
    expect([...raw.writeOnly].sort()).toEqual([
      'LaunchTemplateData',
      'TagSpecifications',
      'VersionDescription',
    ]);
    const exempt = exemptOverrideReadable(raw, 'AWS::EC2::LaunchTemplate');
    // LaunchTemplateData is now compared (removed from both the set and the paths); the
    // other two writeOnly props stay readGaps.
    expect([...exempt.writeOnly].sort()).toEqual(['TagSpecifications', 'VersionDescription']);
    expect(exempt.writeOnlyPaths).not.toContain('LaunchTemplateData');
    // OVERRIDE_READABLE_WRITEONLY entry exists for the type and only lists that prop.
    expect(OVERRIDE_READABLE_WRITEONLY['AWS::EC2::LaunchTemplate']).toEqual(['LaunchTemplateData']);
  });

  it('exemptOverrideReadable un-marks RedshiftServerless Workgroup CC-readable writeOnly props (#490)', () => {
    // ConfigParameters / SecurityGroupIds / SubnetIds are writeOnly in the registry schema,
    // but the Cloud Control read returns all three at the top level — so exempting them makes
    // cdkrd compare (not readGap) the value it already holds, fixing the silent FN. The other
    // writeOnly props (SnapshotArn/SnapshotName/RecoveryPointId) stay readGaps.
    const raw = parseSchema(
      JSON.stringify({
        writeOnlyProperties: [
          '/properties/ConfigParameters',
          '/properties/SecurityGroupIds',
          '/properties/SubnetIds',
          '/properties/SnapshotArn',
          '/properties/RecoveryPointId',
        ],
      })
    );
    const exempt = exemptOverrideReadable(raw, 'AWS::RedshiftServerless::Workgroup');
    expect([...exempt.writeOnly].sort()).toEqual(['RecoveryPointId', 'SnapshotArn']);
    for (const p of ['ConfigParameters', 'SecurityGroupIds', 'SubnetIds']) {
      expect(exempt.writeOnly.has(p)).toBe(false);
      expect(exempt.writeOnlyPaths).not.toContain(p);
    }
    expect(OVERRIDE_READABLE_WRITEONLY['AWS::RedshiftServerless::Workgroup']).toEqual([
      'ConfigParameters',
      'SecurityGroupIds',
      'SubnetIds',
    ]);
  });

  it('exemptOverrideReadable un-marks MSK Configuration ServerProperties (#508)', () => {
    // ServerProperties is writeOnly in the registry schema; the SDK_SUPPLEMENTS reader makes
    // it readable via DescribeConfigurationRevision, so it must be compared, not readGap'd.
    const raw = parseSchema(
      JSON.stringify({ writeOnlyProperties: ['/properties/ServerProperties'] })
    );
    const exempt = exemptOverrideReadable(raw, 'AWS::MSK::Configuration');
    expect(exempt.writeOnly.has('ServerProperties')).toBe(false);
    expect(exempt.writeOnlyPaths).not.toContain('ServerProperties');
    expect(OVERRIDE_READABLE_WRITEONLY['AWS::MSK::Configuration']).toEqual(['ServerProperties']);
  });

  it('exemptOverrideReadable un-marks Cognito IdentityPool CognitoEvents (PushSync/CognitoStreams stay readGaps)', () => {
    // All three are writeOnly in the registry schema, but readCognitoIdentityPool projects
    // only CognitoEvents (the Sync trigger) from cognito-sync; PushSync/CognitoStreams are
    // not projected and must stay readGaps so they can never false-positive.
    const raw = parseSchema(
      JSON.stringify({
        writeOnlyProperties: [
          '/properties/CognitoEvents',
          '/properties/PushSync',
          '/properties/CognitoStreams',
        ],
      })
    );
    const exempt = exemptOverrideReadable(raw, 'AWS::Cognito::IdentityPool');
    expect([...exempt.writeOnly].sort()).toEqual(['CognitoStreams', 'PushSync']);
    expect(exempt.writeOnlyPaths).not.toContain('CognitoEvents');
    expect(OVERRIDE_READABLE_WRITEONLY['AWS::Cognito::IdentityPool']).toEqual(['CognitoEvents']);
  });

  it('exemptOverrideReadable is a no-op for an unlisted type', () => {
    const raw = parseSchema(JSON.stringify({ writeOnlyProperties: ['/properties/Secret'] }));
    const out = exemptOverrideReadable(raw, 'AWS::Other::Thing');
    expect([...out.writeOnly]).toEqual(['Secret']);
  });

  it('bars only HARD createOnly — conditionalCreateOnly stays revertable (mutable in the common case)', () => {
    const info = parseSchema(
      JSON.stringify({
        createOnlyProperties: ['/properties/BucketName', '/properties/Nested/Key'],
        conditionalCreateOnlyProperties: ['/properties/AvailabilityZone'],
      })
    );
    // hard create-only is barred from revert
    expect([...info.createOnly].sort()).toEqual(['BucketName']);
    expect(info.createOnlyPaths).toContain('Nested.Key');
    // a conditional-create-only prop (RDS BackupRetentionPeriod class — modifiable in
    // place in the common case) must NOT be barred, else revert wrongly refuses it
    expect([...info.createOnly]).not.toContain('AvailabilityZone');
    expect(info.createOnlyPaths).not.toContain('AvailabilityZone');
  });

  it('R103: extracts nested defaults through $ref + arrays into defaultPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        properties: {
          TopWithDefault: { default: 7 },
          Config: { $ref: '#/definitions/Config' },
        },
        definitions: {
          Config: {
            type: 'object',
            properties: {
              Origins: { type: 'array', items: { $ref: '#/definitions/Origin' } },
              Comment: { type: 'string', default: '' },
            },
          },
          Origin: {
            type: 'object',
            properties: {
              Port: { type: 'integer', default: 80 },
              Nested: { $ref: '#/definitions/Origin' }, // recursive — must not loop
            },
          },
        },
      })
    );
    // array items contribute a '*' segment, matching readOnlyPaths + live finding paths
    expect(info.defaultPaths['Config.Origins.*.Port']).toBe(80);
    expect(info.defaultPaths['Config.Comment']).toBe('');
    expect(info.defaultPaths['TopWithDefault']).toBe(7);
    // the self-referential `Nested` ($ref Origin) is already on the descent's seen-set,
    // so it is NOT expanded — the recursion guard prevents an infinite walk.
    expect(info.defaultPaths).not.toHaveProperty('Config.Origins.*.Nested.Port');
  });

  it('R103: a schema with no nested defaults yields an empty defaultPaths (minus top-level)', () => {
    const info = parseSchema(JSON.stringify({ properties: { A: {}, B: { default: 1 } } }));
    expect(info.defaultPaths).toEqual({ B: 1 });
  });

  // insertionOrder:false + SCALAR items -> unorderedScalarPaths (schema-driven reorder
  // fold, no per-type table). insertionOrder:true/absent, OBJECT items, and arrays
  // nested through an array element (a `*` path) are all excluded.
  it('parseSchema collects insertionOrder:false SCALAR arrays into unorderedScalarPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        definitions: {
          Cfg: {
            type: 'object',
            properties: {
              Regions: { type: 'array', insertionOrder: false, items: { type: 'string' } },
            },
          },
          Rule: { type: 'object', properties: { Name: { type: 'string' } } },
        },
        properties: {
          // scalar set, AWS-declared unordered -> collected
          Launch: { type: 'array', insertionOrder: false, items: { type: 'string' } },
          // ordered (default true) -> NOT collected
          Layers: { type: 'array', items: { type: 'string' } },
          // object array, even unordered -> NOT collected HERE (identity-keyed items go to
          // canonicalizeTagListsDeep; non-identity items go to unorderedObjectArrayPaths)
          Rules: { type: 'array', insertionOrder: false, items: { $ref: '#/definitions/Rule' } },
          // nested under an object -> collected with dotted path
          HealthCheckConfig: { $ref: '#/definitions/Cfg' },
          // nested THROUGH an array element -> '*' path, skipped
          Groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Ports: { type: 'array', insertionOrder: false, items: { type: 'number' } },
              },
            },
          },
        },
      })
    );
    expect(info.unorderedScalarPaths).toEqual(['HealthCheckConfig.Regions', 'Launch']);
    // the identity-keyed (`Name`) object array is NOT in the object list either
    expect(info.unorderedObjectArrayPaths).toEqual([]);
  });

  // insertionOrder:false + OBJECT items with NO identity field -> unorderedObjectArrayPaths
  // (#459, the schema-driven twin of UNORDERED_OBJECT_ARRAY_PROPS — found live on
  // AccessAnalyzer ArchiveRules). Identity-keyed items (Key/Id/AttributeName/IndexName/
  // Name — already aligned by canonicalizeTagListsDeep), scalar items (the scalar list),
  // ordered arrays, and `*` through-array paths are all excluded.
  it('parseSchema collects insertionOrder:false non-identity OBJECT arrays into unorderedObjectArrayPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        definitions: {
          ArchiveRule: {
            type: 'object',
            properties: {
              RuleName: { type: 'string' },
              Filter: { type: 'array', insertionOrder: false, items: { type: 'object' } },
            },
          },
          Tag: {
            type: 'object',
            properties: { Key: { type: 'string' }, Value: { type: 'string' } },
          },
        },
        properties: {
          // the ArchiveRules shape: unordered, RuleName is NOT an identity field -> collected
          ArchiveRules: {
            type: 'array',
            insertionOrder: false,
            items: { $ref: '#/definitions/ArchiveRule' },
          },
          // identity-keyed ({Key,Value} Tags) -> EXCLUDED (canonicalizeTagListsDeep owns it)
          Tags: { type: 'array', insertionOrder: false, items: { $ref: '#/definitions/Tag' } },
          // ordered (insertionOrder absent) object array -> NOT collected
          Behaviors: { type: 'array', items: { $ref: '#/definitions/ArchiveRule' } },
          // scalar unordered array -> the SCALAR list, not this one
          Subnets: { type: 'array', insertionOrder: false, items: { type: 'string' } },
          // nested under a structured object -> collected with dotted path
          Config: {
            type: 'object',
            properties: {
              Rules: {
                type: 'array',
                insertionOrder: false,
                items: { $ref: '#/definitions/ArchiveRule' },
              },
            },
          },
          // nested THROUGH an array element -> '*' path, skipped
          Groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Rules: {
                  type: 'array',
                  insertionOrder: false,
                  items: { $ref: '#/definitions/ArchiveRule' },
                },
              },
            },
          },
        },
      })
    );
    expect(info.unorderedObjectArrayPaths).toEqual(['ArchiveRules', 'Config.Rules']);
    expect(info.unorderedScalarPaths).toEqual(['Subnets']);
  });

  // free-form map properties (patternProperties / object additionalProperties, no fixed
  // `properties`) -> freeFormMapPaths, so a live-only key under one is surfaced not folded.
  it('parseSchema collects free-form map properties into freeFormMapPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        definitions: {
          // mirrors the real Lambda Environment definition: Variables is a patternProperties map
          Environment: {
            type: 'object',
            properties: {
              Variables: {
                type: 'object',
                additionalProperties: false,
                patternProperties: { '[a-zA-Z][a-zA-Z0-9_]+': { type: 'string' } },
              },
            },
          },
        },
        properties: {
          Environment: { $ref: '#/definitions/Environment' },
          // object additionalProperties (Glue-style free-form map) -> collected
          Parameters: { type: 'object', additionalProperties: { type: 'string' } },
          // STRUCTURED object (fixed properties) -> NOT a free-form map
          Conf: { type: 'object', properties: { Mode: { type: 'string' } } },
          // additionalProperties:false with no patternProperties -> NOT a map
          Closed: { type: 'object', additionalProperties: false },
          // a plain scalar -> ignored
          Name: { type: 'string' },
          // a free-form map NESTED UNDER AN ARRAY ELEMENT (ECS DockerLabels shape) -> KEPT
          // with a `*` segment, so classify's startsWith match aligns the [id]->* live path.
          Containers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                DockerLabels: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
          // a MAP-shaped Tags bag (AWS::SSM::Parameter shape) -> EXCLUDED, so map-tag keys
          // fold like the dominant LIST-shaped Tags rather than surfacing as freeFormKey.
          Tags: { type: 'object', additionalProperties: { type: 'string' } },
        },
      })
    );
    expect(info.freeFormMapPaths).toEqual([
      'Containers.*.DockerLabels',
      'Environment.Variables',
      'Parameters',
    ]);
  });

  it('parseSchema EXCLUDES a map-shaped Tags bag from freeFormMapPaths (tags fold consistently)', () => {
    // AWS::SSM::Parameter models Tags as a patternProperties map; most types use a LIST.
    // Either way an undeclared tag key folds (not freeFormKey), so map-tagged resources are
    // not noisier on the first run than list-tagged ones.
    const info = parseSchema(
      JSON.stringify({
        properties: {
          Tags: { type: 'object', patternProperties: { '.*': { type: 'string' } } },
          Env: { type: 'object', additionalProperties: { type: 'string' } },
        },
      })
    );
    expect(info.freeFormMapPaths).toEqual(['Env']);
  });

  // R130: RDS DBInstance EngineVersion declared `"8.0"` reads back the provisioned
  // full patch `"8.0.45"`. The two sides differ only in PRECISION — the shorter (track)
  // is a leading-segment prefix of the longer (concrete patch) — so it is not drift,
  // in EITHER direction; a genuine track change still differs.
  it('R130: isVersionPrefixMatch folds a version track that is a segment prefix (both directions)', () => {
    // partial -> concrete (DB family: declared track, live full patch)
    expect(isVersionPrefixMatch('8.0', '8.0.45')).toBe(true);
    expect(isVersionPrefixMatch('8', '8.0.45')).toBe(true);
    expect(isVersionPrefixMatch('14.7', '14.7.2')).toBe(true);
    // concrete -> partial (ElastiCache Memcached: declared full `"1.6.22"`, live track `"1.6"`)
    expect(isVersionPrefixMatch('1.6.22', '1.6')).toBe(true);
    expect(isVersionPrefixMatch('8.0.45', '8.0')).toBe(true); // symmetric with the first case
    // NOT a match: equal value (not drift, never reaches here), segment-boundary
    // lookalikes, a genuine track change, non-strings/empties.
    expect(isVersionPrefixMatch('8.0.45', '8.0.45')).toBe(false); // equal → not a prefix
    expect(isVersionPrefixMatch('8.0', '8.05')).toBe(false); // segment boundary
    expect(isVersionPrefixMatch('8.1', '8.0.45')).toBe(false); // different track
    expect(isVersionPrefixMatch('1.5', '1.6.22')).toBe(false); // genuine track change
    expect(isVersionPrefixMatch('8', '80.5')).toBe(false); // segment boundary
    expect(isVersionPrefixMatch('', '8.0.45')).toBe(false);
    expect(isVersionPrefixMatch('8.0', '')).toBe(false);
    expect(isVersionPrefixMatch(8 as unknown, '8.0')).toBe(false); // non-string
  });

  it('isIntelligentTieringMatch: declared Intelligent-Tiering folds against the resolved tier only', () => {
    expect(isIntelligentTieringMatch('Intelligent-Tiering', 'Standard')).toBe(true);
    expect(isIntelligentTieringMatch('Intelligent-Tiering', 'Advanced')).toBe(true);
    // NOT a fold: a concrete declared tier still compares (real Standard↔Advanced drift),
    // and an unexpected live value never silently folds.
    expect(isIntelligentTieringMatch('Standard', 'Advanced')).toBe(false);
    expect(isIntelligentTieringMatch('Advanced', 'Standard')).toBe(false);
    expect(isIntelligentTieringMatch('Intelligent-Tiering', 'Intelligent-Tiering')).toBe(false);
    expect(isIntelligentTieringMatch('Intelligent-Tiering', '')).toBe(false);
    expect(INTELLIGENT_TIERING_PATHS['AWS::SSM::Parameter']?.has('Tier')).toBe(true);
  });

  it('R130: VERSION_PREFIX_PATHS gates the rule to RDS EngineVersion only', () => {
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBInstance']?.has('EngineVersion')).toBe(true);
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBInstance']?.has('Engine')).toBe(false);
    // Aurora clusters resolve a partial track the same way as instances.
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBCluster']?.has('EngineVersion')).toBe(true);
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBCluster']?.has('Engine')).toBe(false);
    // ElastiCache CacheCluster (Memcached patch-truncation, concrete->partial direction).
    expect(VERSION_PREFIX_PATHS['AWS::ElastiCache::CacheCluster']?.has('EngineVersion')).toBe(true);
    expect(VERSION_PREFIX_PATHS['AWS::S3::Bucket']).toBeUndefined(); // not a blanket rule
  });
});

describe('isTrailingDotEqual (Route53 HostedZone Name FQDN trailing dot)', () => {
  it('equates an FQDN that differs only by a trailing dot', () => {
    expect(isTrailingDotEqual('example.com', 'example.com.')).toBe(true);
    expect(isTrailingDotEqual('example.com.', 'example.com')).toBe(true);
    expect(isTrailingDotEqual('a.b.example.com', 'a.b.example.com.')).toBe(true);
    expect(isTrailingDotEqual('example.com.', 'example.com.')).toBe(true);
  });
  it('a genuinely different name still differs; non-strings ignored', () => {
    expect(isTrailingDotEqual('example.com', 'other.com.')).toBe(false);
    expect(isTrailingDotEqual('example.com', 'example.org.')).toBe(false);
    expect(isTrailingDotEqual(5 as unknown, 'example.com.')).toBe(false);
  });
  it('TRAILING_DOT_PATHS gates the rule to the FQDN-normalized name paths', () => {
    expect(TRAILING_DOT_PATHS['AWS::Route53::HostedZone']?.has('Name')).toBe(true);
    expect(TRAILING_DOT_PATHS['AWS::Route53::RecordSet']?.has('Name')).toBe(true);
    // Live-proven: a FORWARD rule's declared "cdkrd-hunt.internal" reads back
    // "cdkrd-hunt.internal." — Resolver appends the FQDN dot on read.
    expect(TRAILING_DOT_PATHS['AWS::Route53Resolver::ResolverRule']?.has('DomainName')).toBe(true);
    // Unrelated paths on those types stay ungated.
    expect(TRAILING_DOT_PATHS['AWS::Route53Resolver::ResolverRule']?.has('Name')).toBe(false);
  });
});

describe('isPhysicalIdSegment (R142 — value echoes a physical-id segment)', () => {
  it('matches any |/:/`/`-separated segment of the physical id', () => {
    const pid = 'api1|res9|GET'; // an ApiGateway Method physical id
    expect(isPhysicalIdSegment('res9', pid)).toBe(true); // the parent Resource id (CacheNamespace default)
    expect(isPhysicalIdSegment('api1', pid)).toBe(true);
    expect(isPhysicalIdSegment('GET', pid)).toBe(true);
    expect(isPhysicalIdSegment('bucket-x', 'arn:aws:s3:::bucket-x')).toBe(true); // ':'-split segment
  });

  it('the WHOLE physical id echoed verbatim matches (XRay SamplingRule.RuleARN)', () => {
    // The live read echoes the rule's own ARN inside the declared SamplingRule
    // object — a full-ARN value a ':'-split could never reassemble.
    const arn = 'arn:aws:xray:us-east-1:111111111111:sampling-rule/cdkrd-hunt-sampling';
    expect(isPhysicalIdSegment(arn, arn)).toBe(true);
    // a DIFFERENT rule's ARN still does not match
    expect(isPhysicalIdSegment(arn.replace('hunt', 'other'), arn)).toBe(false);
  });

  it('a custom value that is NOT a segment does not match', () => {
    expect(isPhysicalIdSegment('my-custom-ns', 'api1|res9|GET')).toBe(false);
    expect(isPhysicalIdSegment('api1|res9', 'api1|res9|GET')).toBe(false); // a partial join, not a segment
  });

  it('non-string value or missing physical id → false', () => {
    expect(isPhysicalIdSegment(123, 'api1|res9|GET')).toBe(false);
    expect(isPhysicalIdSegment('res9', undefined)).toBe(false);
  });
});

describe('stripAsymmetricIdentityFields (AWS-generated identity field)', () => {
  it('strips a live-only identity field so neither side sorts by it (S3 lifecycle no-id)', () => {
    // declared rules have NO Id (CDK addLifecycleRule default); live rules carry an
    // AWS-generated Id. Without the strip, the per-side identity sort reorders live by
    // the generated Id and misaligns every rule.
    const declared = {
      LifecycleConfiguration: {
        Rules: [{ Prefix: 'zeta/' }, { Prefix: 'alpha/' }, { Prefix: 'mike/' }],
      },
    };
    const live = {
      LifecycleConfiguration: {
        Rules: [
          { Id: 'gen-zeta', Prefix: 'zeta/' },
          { Id: 'gen-alpha', Prefix: 'alpha/' },
          { Id: 'gen-mike', Prefix: 'mike/' },
        ],
      },
    };
    stripAsymmetricIdentityFields(declared, live);
    // Id deleted from every live rule -> identityField no longer keys the array.
    for (const r of live.LifecycleConfiguration.Rules) expect('Id' in r).toBe(false);
  });

  it('leaves an identity field present on BOTH sides untouched (CloudFront Origins)', () => {
    const declared = {
      Origins: [
        { Id: 'o1', DomainName: 'a' },
        { Id: 'o2', DomainName: 'b' },
      ],
    };
    const live = {
      Origins: [
        { Id: 'o1', DomainName: 'a' },
        { Id: 'o2', DomainName: 'b' },
      ],
    };
    stripAsymmetricIdentityFields(declared, live);
    expect(live.Origins.every((o) => 'Id' in o)).toBe(true);
    expect(declared.Origins.every((o) => 'Id' in o)).toBe(true);
  });

  it('strips a declared-only identity field too (reverse asymmetry)', () => {
    const declared = {
      Rules: [
        { Id: 'a', V: 1 },
        { Id: 'b', V: 2 },
      ],
    };
    const live = { Rules: [{ V: 1 }, { V: 2 }] };
    stripAsymmetricIdentityFields(declared, live);
    expect(declared.Rules.every((r) => 'Id' in r)).toBe(false);
  });
});

describe('isAccessStringEqual — Redis/Valkey ACL canonicalization (#482)', () => {
  it('the service-inserted -@all baseline term is not drift', () => {
    // Observed live on CdkRealDriftIntegCacheUsers: declared `on ~app:* +@read` reads
    // back `on ~app:* -@all +@read` after ElastiCache canonicalizes the write.
    expect(isAccessStringEqual('on ~app:* +@read', 'on ~app:* -@all +@read')).toBe(true);
    expect(isAccessStringEqual('on ~* &* +@read', 'on ~* &* -@all +@read')).toBe(true);
    // symmetric + identity (a declared string that already states -@all)
    expect(isAccessStringEqual('on ~app:* -@all +@read', 'on ~app:* +@read')).toBe(true);
    expect(isAccessStringEqual('off ~* -@all', 'off ~* -@all')).toBe(true);
  });

  it('a genuine ACL change still differs (fail-closed)', () => {
    // the out-of-band grant the supplement exists to catch
    expect(isAccessStringEqual('on ~app:* +@read', 'on ~app:* -@all +@read +@write')).toBe(false);
    // key-pattern widening
    expect(isAccessStringEqual('on ~app:* +@read', 'on ~* -@all +@read')).toBe(false);
    // on/off toggle
    expect(isAccessStringEqual('on ~app:* +@read', 'off ~app:* -@all +@read')).toBe(false);
    // order matters in Redis ACLs (later terms override) — never sorted away
    expect(isAccessStringEqual('on +@all -@dangerous', 'on -@dangerous +@all')).toBe(false);
  });

  it('non-strings never match', () => {
    expect(isAccessStringEqual(undefined, 'on ~* -@all')).toBe(false);
    expect(isAccessStringEqual('on ~* -@all', 42)).toBe(false);
  });
});

describe('isPropertiesFileEqual — Java .properties blob (MSK ServerProperties, #508)', () => {
  it('line order / blank lines / comments / trailing newline are cosmetic — not drift', () => {
    const declared =
      'auto.create.topics.enable=false\ndefault.replication.factor=3\nmin.insync.replicas=2\nlog.retention.hours=168\n';
    const live =
      '# managed by cdkrd\nlog.retention.hours=168\nmin.insync.replicas=2\n\ndefault.replication.factor=3\nauto.create.topics.enable=false';
    expect(isPropertiesFileEqual(declared, live)).toBe(true);
    // whitespace around `=` is trimmed
    expect(isPropertiesFileEqual('a=1\nb=2', 'a = 1\nb= 2')).toBe(true);
  });

  it('a genuine key/value change still differs (fail-closed)', () => {
    // the out-of-band flip the supplement exists to catch
    expect(
      isPropertiesFileEqual('auto.create.topics.enable=false', 'auto.create.topics.enable=true')
    ).toBe(false);
    // an added key
    expect(isPropertiesFileEqual('a=1', 'a=1\nb=2')).toBe(false);
    // a removed key
    expect(isPropertiesFileEqual('a=1\nb=2', 'a=1')).toBe(false);
  });

  it('non-strings never match', () => {
    expect(isPropertiesFileEqual(undefined, 'a=1')).toBe(false);
    expect(isPropertiesFileEqual('a=1', 42)).toBe(false);
  });
});

describe('isCaseInsensitiveKeyMapEqual — free-form map key-case fold (#494)', () => {
  it('a pure camelCase<->PascalCase key re-casing with equal values folds', () => {
    // DataBrew Recipe: template + service carry camelCase, CC read remaps to PascalCase.
    expect(
      isCaseInsensitiveKeyMapEqual({ sourceColumn: 'field1' }, { SourceColumn: 'field1' })
    ).toBe(true);
    expect(
      isCaseInsensitiveKeyMapEqual(
        { sourceColumn: 'field1', targetColumn: 'field2' },
        { SourceColumn: 'field1', TargetColumn: 'field2' }
      )
    ).toBe(true);
    // key order is irrelevant (maps are unordered)
    expect(
      isCaseInsensitiveKeyMapEqual(
        { targetColumn: 'field2', sourceColumn: 'field1' },
        { SourceColumn: 'field1', TargetColumn: 'field2' }
      )
    ).toBe(true);
  });

  it('a real change still surfaces (equality-gated per key-pair, fail-closed)', () => {
    // value change on a matched key
    expect(isCaseInsensitiveKeyMapEqual({ sourceColumn: 'a' }, { SourceColumn: 'b' })).toBe(false);
    // key add (extra key on one side)
    expect(
      isCaseInsensitiveKeyMapEqual(
        { sourceColumn: 'field1' },
        { SourceColumn: 'field1', TargetColumn: 'field2' }
      )
    ).toBe(false);
    // a genuinely different key (not a case variant of any declared key)
    expect(isCaseInsensitiveKeyMapEqual({ sourceColumn: 'field1' }, { DestColumn: 'field1' })).toBe(
      false
    );
  });

  it('a duplicate case-folded key on either side fails closed', () => {
    expect(
      isCaseInsensitiveKeyMapEqual(
        { sourceColumn: 'x', SourceColumn: 'x' },
        { SourceColumn: 'x', Sourcecolumn: 'x' }
      )
    ).toBe(false);
  });

  it('nested object/array values are compared structurally', () => {
    expect(isCaseInsensitiveKeyMapEqual({ opts: { a: 1 } }, { Opts: { a: 1 } })).toBe(true);
    expect(isCaseInsensitiveKeyMapEqual({ opts: { a: 1 } }, { Opts: { a: 2 } })).toBe(false);
  });

  it('non-object / array inputs never match', () => {
    expect(isCaseInsensitiveKeyMapEqual('x', 'X')).toBe(false);
    expect(isCaseInsensitiveKeyMapEqual([{ a: 1 }], [{ A: 1 }])).toBe(false);
    expect(isCaseInsensitiveKeyMapEqual(null, {})).toBe(false);
  });

  it('the fold is scoped to the curated DataBrew Recipe Parameters path', () => {
    expect(
      CASE_INSENSITIVE_KEY_PATHS['AWS::DataBrew::Recipe']?.has('Steps[].Action.Parameters')
    ).toBe(true);
  });
});

describe('#664 ApiGatewayV2 WebSocket first-run undeclared folds', () => {
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
  const bare = (resourceType: string, declared: Record<string, unknown> = {}): DesiredResource => ({
    logicalId: 'WsApi',
    resourceType,
    physicalId: 'ws-phys',
    declared,
  });
  const t = (
    resourceType: string,
    declared: Record<string, unknown>,
    live: Record<string, unknown>
  ): { atDefault: string[]; undeclared: string[] } => {
    const findings: Finding[] = classifyResource(bare(resourceType, declared), live, emptySchema);
    const by = (tier: string) =>
      findings
        .filter((f) => f.tier === tier)
        .map((f) => f.path)
        .sort();
    return { atDefault: by('atDefault'), undeclared: by('undeclared') };
  };

  it('the WebSocket defaults are registered in the fold tables', () => {
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Api'].ApiKeySelectionExpression).toBe(
      '$request.header.x-api-key'
    );
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Integration'].PayloadFormatVersion).toBe('1.0');
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Integration'].IntegrationMethod).toBe('POST');
    expect(KNOWN_DEFAULTS['AWS::ApiGatewayV2::Integration'].PassthroughBehavior).toBe(
      'WHEN_NO_MATCH'
    );
    expect(
      KNOWN_DEFAULT_PATHS['AWS::ApiGatewayV2::Stage']['DefaultRouteSettings.LoggingLevel']
    ).toBe('OFF');
  });

  it('Api: an undeclared ApiKeySelectionExpression at the default folds to atDefault', () => {
    const r = t(
      'AWS::ApiGatewayV2::Api',
      { RouteSelectionExpression: '$request.body.action' },
      {
        RouteSelectionExpression: '$request.body.action',
        ApiKeySelectionExpression: '$request.header.x-api-key',
      }
    );
    expect(r.atDefault).toContain('ApiKeySelectionExpression');
    expect(r.undeclared).not.toContain('ApiKeySelectionExpression');
  });

  it('Api: a CHANGED ApiKeySelectionExpression still surfaces (equality-gated)', () => {
    const r = t(
      'AWS::ApiGatewayV2::Api',
      {},
      { ApiKeySelectionExpression: '$request.querystring.api_key' }
    );
    expect(r.undeclared).toContain('ApiKeySelectionExpression');
    expect(r.atDefault).not.toContain('ApiKeySelectionExpression');
  });

  it('Integration: undeclared WebSocket defaults (PayloadFormatVersion/IntegrationMethod/PassthroughBehavior) fold to atDefault', () => {
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', IntegrationUri: 'arn:aws:lambda:...' },
      {
        ApiId: 'api1',
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: 'arn:aws:lambda:...',
        PayloadFormatVersion: '1.0',
        IntegrationMethod: 'POST',
        PassthroughBehavior: 'WHEN_NO_MATCH',
      }
    );
    expect(r.atDefault).toContain('PayloadFormatVersion');
    expect(r.atDefault).toContain('IntegrationMethod');
    expect(r.atDefault).toContain('PassthroughBehavior');
    expect(r.undeclared).toEqual([]);
  });

  it('Integration: a DECLARED PayloadFormatVersion is never folded (HTTP-API 2.0 safety)', () => {
    // An HTTP-API L2 always DECLARES PayloadFormatVersion "2.0"; a declared value is compared
    // in the declared dimension, never folded by the equality-gated "1.0" KNOWN_DEFAULTS entry.
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0' },
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0' }
    );
    // PayloadFormatVersion is declared+equal → no undeclared/atDefault finding for it at all.
    expect(r.atDefault).not.toContain('PayloadFormatVersion');
    expect(r.undeclared).not.toContain('PayloadFormatVersion');
  });

  it('Integration: a CHANGED PassthroughBehavior still surfaces (equality-gated)', () => {
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY' },
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', PassthroughBehavior: 'WHEN_NO_TEMPLATES' }
    );
    expect(r.undeclared).toContain('PassthroughBehavior');
    expect(r.atDefault).not.toContain('PassthroughBehavior');
  });

  it('Integration: TimeoutInMillis one-of defaults {29000, 30000} are registered', () => {
    expect(KNOWN_DEFAULT_ONE_OF['AWS::ApiGatewayV2::Integration'].TimeoutInMillis).toEqual([
      29000, 30000,
    ]);
  });

  it('Integration: an undeclared WebSocket TimeoutInMillis=29000 folds to atDefault', () => {
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', IntegrationUri: 'arn:aws:lambda:...' },
      {
        ApiId: 'api1',
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: 'arn:aws:lambda:...',
        TimeoutInMillis: 29000,
      }
    );
    expect(r.atDefault).toContain('TimeoutInMillis');
    expect(r.undeclared).not.toContain('TimeoutInMillis');
  });

  it('Integration: an undeclared HTTP TimeoutInMillis=30000 also folds to atDefault (the peer default)', () => {
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'HTTP_PROXY' },
      { ApiId: 'api1', IntegrationType: 'HTTP_PROXY', TimeoutInMillis: 30000 }
    );
    expect(r.atDefault).toContain('TimeoutInMillis');
    expect(r.undeclared).not.toContain('TimeoutInMillis');
  });

  it('Integration: an undeclared TimeoutInMillis OUTSIDE the set (10000) still surfaces (equality-gated)', () => {
    const r = t(
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY' },
      { ApiId: 'api1', IntegrationType: 'AWS_PROXY', TimeoutInMillis: 10000 }
    );
    expect(r.undeclared).toContain('TimeoutInMillis');
    expect(r.atDefault).not.toContain('TimeoutInMillis');
  });

  it('Stage: an undeclared DefaultRouteSettings.LoggingLevel at the default folds to atDefault', () => {
    // CDK renders only the throttling knobs inside DefaultRouteSettings; AWS fills LoggingLevel "OFF".
    const r = t(
      'AWS::ApiGatewayV2::Stage',
      {
        ApiId: 'api1',
        StageName: 'dev',
        DefaultRouteSettings: { ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 },
      },
      {
        ApiId: 'api1',
        StageName: 'dev',
        DefaultRouteSettings: {
          ThrottlingRateLimit: 100,
          ThrottlingBurstLimit: 50,
          LoggingLevel: 'OFF',
        },
      }
    );
    expect(r.atDefault).toContain('DefaultRouteSettings.LoggingLevel');
    expect(r.undeclared).not.toContain('DefaultRouteSettings.LoggingLevel');
  });

  it('Stage: LoggingLevel turned on out of band still surfaces (equality-gated)', () => {
    const r = t(
      'AWS::ApiGatewayV2::Stage',
      {
        ApiId: 'api1',
        StageName: 'dev',
        DefaultRouteSettings: { ThrottlingRateLimit: 100 },
      },
      {
        ApiId: 'api1',
        StageName: 'dev',
        DefaultRouteSettings: { ThrottlingRateLimit: 100, LoggingLevel: 'INFO' },
      }
    );
    expect(r.undeclared).toContain('DefaultRouteSettings.LoggingLevel');
    expect(r.atDefault).not.toContain('DefaultRouteSettings.LoggingLevel');
  });
});

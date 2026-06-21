import { describe, expect, it } from 'vite-plus/test';
import { stripCcApiAwsManagedFields } from '../src/normalize/cc-api-strip.js';
import {
  awsManagedTags,
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
  isAllAwsTags,
  isPemEqual,
  isPhysicalIdSegment,
  isTrivialEmpty,
  isVersionPrefixMatch,
  KNOWN_DEFAULTS,
  stripAwsTagsDeep,
  VERSION_PREFIX_PATHS,
  isTrailingDotEqual,
  TRAILING_DOT_PATHS,
  ORDER_SIGNIFICANT_ARRAY_KEYS,
} from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import { parseSchema } from '../src/schema/schema-strip.js';

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
    // arrays do NOT recurse — only length 0 is empty ([false] may be a meaningful list)
    expect(isTrivialEmpty([false])).toBe(false);
    expect(isTrivialEmpty({ L: [false] })).toBe(false);
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

  it('parses createOnly + conditionalCreateOnly (both = needs replacement)', () => {
    const info = parseSchema(
      JSON.stringify({
        createOnlyProperties: ['/properties/BucketName', '/properties/Nested/Key'],
        conditionalCreateOnlyProperties: ['/properties/AvailabilityZone'],
      })
    );
    expect([...info.createOnly].sort()).toEqual(['AvailabilityZone', 'BucketName']);
    expect(info.createOnlyPaths).toContain('Nested.Key');
    expect(info.createOnlyPaths).toContain('AvailabilityZone');
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

  // R130: RDS DBInstance EngineVersion declared `"8.0"` reads back the provisioned
  // full patch `"8.0.45"`. A declared dotted-version that is a leading-segment PREFIX
  // of the live full version is not drift; a genuine track change still differs.
  it('R130: isVersionPrefixMatch matches a declared version track that is a segment prefix', () => {
    expect(isVersionPrefixMatch('8.0', '8.0.45')).toBe(true);
    expect(isVersionPrefixMatch('8', '8.0.45')).toBe(true);
    expect(isVersionPrefixMatch('14.7', '14.7.2')).toBe(true);
    // NOT a match: equal value (not drift, never reaches here), longer declared,
    // segment-boundary lookalikes, a genuine track change, non-strings/empties.
    expect(isVersionPrefixMatch('8.0.45', '8.0.45')).toBe(false); // equal → not a prefix
    expect(isVersionPrefixMatch('8.0.45', '8.0')).toBe(false); // declared longer
    expect(isVersionPrefixMatch('8.0', '8.05')).toBe(false); // segment boundary
    expect(isVersionPrefixMatch('8.1', '8.0.45')).toBe(false); // different track
    expect(isVersionPrefixMatch('8', '80.5')).toBe(false); // segment boundary
    expect(isVersionPrefixMatch('', '8.0.45')).toBe(false);
    expect(isVersionPrefixMatch('8.0', '')).toBe(false);
    expect(isVersionPrefixMatch(8 as unknown, '8.0')).toBe(false); // non-string
  });

  it('R130: VERSION_PREFIX_PATHS gates the rule to RDS EngineVersion only', () => {
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBInstance']?.has('EngineVersion')).toBe(true);
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBInstance']?.has('Engine')).toBe(false);
    // Aurora clusters resolve a partial track the same way as instances.
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBCluster']?.has('EngineVersion')).toBe(true);
    expect(VERSION_PREFIX_PATHS['AWS::RDS::DBCluster']?.has('Engine')).toBe(false);
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
  it('TRAILING_DOT_PATHS gates the rule to HostedZone Name', () => {
    expect(TRAILING_DOT_PATHS['AWS::Route53::HostedZone']?.has('Name')).toBe(true);
    expect(TRAILING_DOT_PATHS['AWS::Route53::RecordSet']).toBeUndefined();
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

  it('a custom value that is NOT a segment does not match', () => {
    expect(isPhysicalIdSegment('my-custom-ns', 'api1|res9|GET')).toBe(false);
    expect(isPhysicalIdSegment('api1|res9', 'api1|res9|GET')).toBe(false); // a partial join, not a segment
  });

  it('non-string value or missing physical id → false', () => {
    expect(isPhysicalIdSegment(123, 'api1|res9|GET')).toBe(false);
    expect(isPhysicalIdSegment('res9', undefined)).toBe(false);
  });
});

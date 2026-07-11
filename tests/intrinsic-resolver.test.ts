import { describe, expect, it } from 'vite-plus/test';
import {
  containsDynamicReference,
  hasUnresolved,
  isDynamicReference,
  NOVALUE,
  resolve,
  resolveProperties,
  UNRESOLVED,
} from '../src/normalize/intrinsic-resolver.js';
import type { ResolverContext } from '../src/types.js';

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    params: { Env: 'prod' },
    pseudo: {
      'AWS::Region': 'us-east-1',
      'AWS::AccountId': '123',
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': 'S',
      'AWS::StackId': 'id',
    },
    conditions: {},
    physIds: { MyBucket: 'bucket-phys' },
    liveAttrs: {},
    mappings: {},
    exports: {},
    condCache: new Map(),
    ...over,
  };
}

describe('intrinsic resolver', () => {
  it('resolves Ref to params / pseudo / physical id, UNRESOLVED otherwise', () => {
    expect(resolve({ Ref: 'Env' }, ctx())).toBe('prod');
    expect(resolve({ Ref: 'AWS::Region' }, ctx())).toBe('us-east-1');
    expect(resolve({ Ref: 'MyBucket' }, ctx())).toBe('bucket-phys');
    expect(resolve({ Ref: 'Nope' }, ctx())).toBe(UNRESOLVED);
  });

  it('resolves Fn::Sub with pseudo + vars; GetAtt-form unresolved without live attrs', () => {
    expect(resolve({ 'Fn::Sub': 'a-${Env}-${AWS::Region}' }, ctx())).toBe('a-prod-us-east-1');
    expect(resolve({ 'Fn::Sub': '${Thing.Arn}' }, ctx())).toBe(UNRESOLVED);
  });

  it('resolves Fn::Sub GetAtt-form against live attributes', () => {
    const c = ctx({ liveAttrs: { Thing: { Arn: 'arn:aws:x:::thing' } } });
    expect(resolve({ 'Fn::Sub': 'v=${Thing.Arn}' }, c)).toBe('v=arn:aws:x:::thing');
  });

  // Fn::Base64 is the deterministic transform CDK wraps EC2 UserData in; resolving it
  // lets the (readable, mutable) UserData property be compared instead of left a blind
  // spot. base64('hello') === 'aGVsbG8='.
  it('resolves Fn::Base64 of a literal string', () => {
    expect(resolve({ 'Fn::Base64': 'hello' }, ctx())).toBe('aGVsbG8=');
  });

  it('resolves Fn::Base64 of a nested Fn::Sub (the EC2 UserData shape)', () => {
    // base64('echo prod') === 'ZWNobyBwcm9k'
    expect(resolve({ 'Fn::Base64': { 'Fn::Sub': 'echo ${Env}' } }, ctx())).toBe('ZWNobyBwcm9k');
  });

  it('Fn::Base64 fails closed (UNRESOLVED) when its inner is unresolved or not a string', () => {
    // inner GetAtt with no live attrs -> UNRESOLVED propagates (never encode the symbol)
    expect(resolve({ 'Fn::Base64': { 'Fn::GetAtt': ['X', 'Arn'] } }, ctx())).toBe(UNRESOLVED);
    // CFn Fn::Base64 takes only a String; a non-string inner fails closed, not `[object Object]`
    expect(resolve({ 'Fn::Base64': { foo: 'bar' } }, ctx())).toBe(UNRESOLVED);
  });

  it('evaluates Fn::If via conditions', () => {
    const c = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } } });
    expect(resolve({ 'Fn::If': ['IsProd', 'yes', 'no'] }, c)).toBe('yes');
  });

  // CFn evaluates Fn::Equals as a STRING comparison; a Number/Boolean parameter is
  // carried as a string, so it must equal a numeric/boolean template LITERAL — else the
  // wrong Fn::If branch bakes a corrupted declared value into the diff.
  it('Fn::Equals coerces a stringified Number/Boolean param to a numeric/boolean literal', () => {
    const cNum = ctx({
      params: { Env: 'prod', MaxAZs: '2' }, // a Number param, stringified
      conditions: { HasTwo: { 'Fn::Equals': [{ Ref: 'MaxAZs' }, 2] } }, // literal NUMBER
    });
    expect(resolve({ 'Fn::If': ['HasTwo', 2, 1] }, cNum)).toBe(2); // was 1 (wrong branch)
    expect(resolve({ 'Fn::Equals': [{ Ref: 'MaxAZs' }, 2] }, cNum)).toBe(true);

    const cBool = ctx({
      params: { Env: 'prod', Enabled: 'true' }, // a Boolean param, stringified
      conditions: { On: { 'Fn::Equals': [{ Ref: 'Enabled' }, true] } }, // literal BOOLEAN
    });
    expect(resolve({ 'Fn::If': ['On', 'on', 'off'] }, cBool)).toBe('on');

    // genuine inequality still differs (no over-coercion): "2" != 3, "2" != "2.0"
    const cNo = ctx({ params: { N: '2' }, conditions: { C: { 'Fn::Equals': [{ Ref: 'N' }, 3] } } });
    expect(resolve({ 'Fn::If': ['C', 'yes', 'no'] }, cNo)).toBe('no');
    expect(resolve({ 'Fn::Equals': ['2.0', 2] }, ctx())).toBe(false); // CFn Equals is exact-string
  });

  it('Fn::GetAtt is UNRESOLVED without live attrs; Fn::Join drops NoValue', () => {
    expect(resolve({ 'Fn::GetAtt': ['X', 'Arn'] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Join': ['-', ['a', { Ref: 'AWS::NoValue' }, 'b']] }, ctx())).toBe('a-b');
  });

  // A non-scalar resolved part (a nested object/array carrying a deep unresolved
  // GetAtt, or a malformed non-string list element) must fail closed to UNRESOLVED
  // — never String()-leak `[object Object]` / `Symbol(unresolved)` into the joined
  // value, which would mis-compare as false drift.
  it('Fn::Join fails closed when a list element is a non-scalar carrying deep UNRESOLVED', () => {
    expect(
      resolve({ 'Fn::Join': ['', ['p-', { wrap: { 'Fn::GetAtt': ['X', 'Y'] } }, '-s']] }, ctx())
    ).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Join': ['', ['a', [{ 'Fn::GetAtt': ['X', 'Y'] }], 'b']] }, ctx())).toBe(
      UNRESOLVED
    );
    // a fully-scalar join still resolves (regression guard)
    expect(resolve({ 'Fn::Join': ['-', ['a', 'b', 'c']] }, ctx())).toBe('a-b-c');
  });

  // The Fn::Sub variable-map branch must match the Ref/GetAtt branches: a NOVALUE or
  // object/array resolution is unresolvable, not `Symbol(novalue)` / `[object Object]`.
  it('Fn::Sub fails closed when a variable resolves to a non-scalar', () => {
    expect(resolve({ 'Fn::Sub': ['x-${V}', { V: { Ref: 'AWS::NoValue' } }] }, ctx())).toBe(
      UNRESOLVED
    );
    expect(
      resolve({ 'Fn::Sub': ['x-${V}', { V: { wrap: { 'Fn::GetAtt': ['X', 'Y'] } } }] }, ctx())
    ).toBe(UNRESOLVED);
    // a scalar var (incl. a numeric Ref) still substitutes (regression guard)
    expect(resolve({ 'Fn::Sub': ['x-${V}', { V: 'ok' }] }, ctx())).toBe('x-ok');
  });

  // The DOTTED-GetAtt and plain-Ref branches of Fn::Sub must fail closed on a
  // non-scalar exactly like the variable-map branch above — previously they only
  // guarded UNRESOLVED/NOVALUE and leaked `[object Object]` for an object GetAtt
  // attribute or the JS comma-join for an array Ref, producing a bogus declared
  // value that the diff then reported as drift on a clean stack.
  it('Fn::Sub GetAtt/Ref branches fail closed on a non-scalar resolution', () => {
    const c = ctx({
      params: { Env: 'prod', SubnetList: ['subnet-a', 'subnet-b'] }, // CommaDelimitedList
      liveAttrs: { DB: { Endpoint: { Address: 'db.host', Port: 5432 }, Address: 'db.host' } },
    });
    // object GetAtt attribute -> UNRESOLVED (was "[object Object]")
    expect(resolve({ 'Fn::Sub': 'e=${DB.Endpoint}' }, c)).toBe(UNRESOLVED);
    // array Ref (a CommaDelimitedList parameter) -> UNRESOLVED (was "subnet-a,subnet-b")
    expect(resolve({ 'Fn::Sub': 'sn-${SubnetList}' }, c)).toBe(UNRESOLVED);
    // scalar interpolants still resolve (regression guard)
    expect(resolve({ 'Fn::Sub': 'env-${Env}' }, c)).toBe('env-prod');
    expect(resolve({ 'Fn::Sub': 'h=${DB.Address}' }, c)).toBe('h=db.host');
  });

  it('Fn::GetAtt resolves against live attributes (incl. dotted path), else UNRESOLVED', () => {
    const c = ctx({
      liveAttrs: { Role: { Arn: 'arn:aws:iam::123:role/r' }, Db: { Endpoint: { Address: 'h' } } },
    });
    expect(resolve({ 'Fn::GetAtt': ['Role', 'Arn'] }, c)).toBe('arn:aws:iam::123:role/r');
    expect(resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, c)).toBe('h');
    // referenced resource present but attribute absent -> fail-closed UNRESOLVED
    expect(resolve({ 'Fn::GetAtt': ['Role', 'Missing'] }, c)).toBe(UNRESOLVED);
    // referenced resource not read -> UNRESOLVED (never fabricate)
    expect(resolve({ 'Fn::GetAtt': ['Ghost', 'Arn'] }, c)).toBe(UNRESOLVED);
  });

  // A GetAtt attribute that MIRRORS a declared property (an IdentityPool's readOnly
  // `Name` == its declared `IdentityPoolName`) must resolve to the DECLARED value, not
  // the live one — else renaming the pool in the console cascades into phantom drift on
  // every consumer that bakes the name into one of its own declared properties (the
  // authenticated/unauthenticated Role `Description`).
  it('Fn::GetAtt of a declared-property-mirroring attr resolves to the DECLARED value, not live', () => {
    const c = ctx({
      typeOf: { IdPool: 'AWS::Cognito::IdentityPool' },
      declaredRawProps: { IdPool: { IdentityPoolName: 'my-pool' } },
      liveAttrs: { IdPool: { Id: 'us-east-1:abc', Name: 'my-pool-RENAMED' } },
    });
    expect(resolve({ 'Fn::GetAtt': ['IdPool', 'Name'] }, c)).toBe('my-pool');
    expect(
      resolve(
        {
          'Fn::Join': [
            '',
            ['Default Authenticated Role for Identity Pool ', { 'Fn::GetAtt': ['IdPool', 'Name'] }],
          ],
        },
        c
      )
    ).toBe('Default Authenticated Role for Identity Pool my-pool');
    // a NON-mirroring attribute (Id) still resolves against live
    expect(resolve({ 'Fn::GetAtt': ['IdPool', 'Id'] }, c)).toBe('us-east-1:abc');
  });

  it('Fn::GetAtt of a mirroring attr falls back to LIVE when the declared property is absent', () => {
    const c = ctx({
      typeOf: { IdPool: 'AWS::Cognito::IdentityPool' },
      declaredRawProps: { IdPool: {} }, // auto-named pool: no IdentityPoolName declared
      liveAttrs: { IdPool: { Name: 'auto-generated' } },
    });
    expect(resolve({ 'Fn::GetAtt': ['IdPool', 'Name'] }, c)).toBe('auto-generated');
  });

  // A parent stack consuming a NESTED stack's output uses
  // `Fn::GetAtt [Nested, "Outputs.<key>"]` / `Fn::Sub ${Nested.Outputs.<key>}`.
  // The live Cloud Control model for AWS::CloudFormation::Stack stores `Outputs` as
  // an ARRAY of { OutputKey, OutputValue }, so a naive path descent indexes the array
  // by the string key -> permanently UNRESOLVED (issue #782). Resolve via an
  // OutputKey -> OutputValue lookup, scoped to AWS::CloudFormation::Stack.
  it('Fn::GetAtt Outputs.<key> resolves against a nested Stacks OutputKey/OutputValue array', () => {
    const c = ctx({
      typeOf: { Nested: 'AWS::CloudFormation::Stack' },
      liveAttrs: {
        Nested: {
          Outputs: [
            { OutputKey: 'BucketArn', OutputValue: 'arn:aws:s3:::my-nested-bucket' },
            { OutputKey: 'QueueUrl', OutputValue: 'https://sqs/q' },
          ],
        },
      },
    });
    expect(resolve({ 'Fn::GetAtt': ['Nested', 'Outputs.BucketArn'] }, c)).toBe(
      'arn:aws:s3:::my-nested-bucket'
    );
    expect(resolve({ 'Fn::GetAtt': ['Nested', 'Outputs.QueueUrl'] }, c)).toBe('https://sqs/q');
    // the Fn::Sub ${Nested.Outputs.<key>} form goes through the same resolveGetAtt path
    expect(resolve({ 'Fn::Sub': 'b=${Nested.Outputs.BucketArn}' }, c)).toBe(
      'b=arn:aws:s3:::my-nested-bucket'
    );
    // an unknown output key fails closed (never fabricates a value)
    expect(resolve({ 'Fn::GetAtt': ['Nested', 'Outputs.Nope'] }, c)).toBe(UNRESOLVED);
  });

  // The Outputs-array special case is scoped to AWS::CloudFormation::Stack — for every
  // other type getPath's general behavior is unchanged (a non-Stack type with an
  // Outputs array indexed by key still fails closed, i.e. no accidental widening).
  it('Outputs-array lookup is confined to AWS::CloudFormation::Stack', () => {
    const c = ctx({
      typeOf: { Other: 'AWS::Some::Other' },
      liveAttrs: {
        Other: { Outputs: [{ OutputKey: 'BucketArn', OutputValue: 'arn:aws:s3:::x' }] },
      },
    });
    // not a Stack -> array indexed by key -> undefined -> UNRESOLVED (unchanged)
    expect(resolve({ 'Fn::GetAtt': ['Other', 'Outputs.BucketArn'] }, c)).toBe(UNRESOLVED);
  });

  it('resolveProperties prunes NoValue keys', () => {
    const out = resolveProperties({ A: 'x', B: { Ref: 'AWS::NoValue' } }, ctx());
    expect(out).toEqual({ A: 'x' });
  });

  it('FAIL-CLOSED: Fn::If with an unresolvable condition → UNRESOLVED (no guessed branch)', () => {
    const c = ctx({ conditions: { C: { 'Fn::Equals': [{ Ref: 'Unknown' }, 'x'] } } });
    expect(resolve({ 'Fn::If': ['C', 'then', 'else'] }, c)).toBe(UNRESOLVED);
  });

  it('FAIL-CLOSED: a self-referential / cyclic condition → UNRESOLVED without hanging', () => {
    // A references itself through an Fn::And operand — CFn rejects this at deploy, but a
    // --pre-deploy synth / hand-rolled template could carry it. The cache is seeded with
    // UNRESOLVED before recursing, so the cycle terminates rather than stack-overflowing.
    const selfRef = ctx({ conditions: { A: { 'Fn::And': [{ Condition: 'A' }, true] } } });
    expect(resolve({ 'Fn::If': ['A', 'then', 'else'] }, selfRef)).toBe(UNRESOLVED);

    // Mutual cycle A→B→A.
    const mutual = ctx({
      conditions: {
        A: { 'Fn::And': [{ Condition: 'B' }, true] },
        B: { 'Fn::And': [{ Condition: 'A' }, true] },
      },
    });
    expect(resolve({ 'Fn::If': ['A', 'then', 'else'] }, mutual)).toBe(UNRESOLVED);
  });

  it('FAIL-CLOSED: Fn::Equals / And / Or / Not with an unresolved operand → UNRESOLVED', () => {
    expect(resolve({ 'Fn::Equals': [{ Ref: 'Unknown' }, 'x'] }, ctx())).toBe(UNRESOLVED);
    const c = ctx({ conditions: { U: { 'Fn::Equals': [{ Ref: 'Unknown' }, 'x'] } } });
    expect(resolve({ 'Fn::And': [{ Condition: 'U' }, true] }, c)).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Not': [{ Condition: 'U' }] }, c)).toBe(UNRESOLVED);
  });

  it('CommaDelimitedList param resolves to an array (Fn::Join + HasX condition work)', () => {
    const empty = ctx({ params: { List: [] } });
    expect(resolve({ 'Fn::Join': ['', { Ref: 'List' }] }, empty)).toBe('');
    // HasList = Not(Equals(Join('', List), '')) → false for empty list
    const c = ctx({
      params: { List: [] },
      conditions: {
        HasList: { 'Fn::Not': [{ 'Fn::Equals': [{ 'Fn::Join': ['', { Ref: 'List' }] }, ''] }] },
      },
    });
    expect(resolve({ 'Fn::If': ['HasList', 'yes', 'no'] }, c)).toBe('no');
    const c2 = ctx({
      params: { List: ['a', 'b'] },
      conditions: {
        HasList: { 'Fn::Not': [{ 'Fn::Equals': [{ 'Fn::Join': ['', { Ref: 'List' }] }, ''] }] },
      },
    });
    expect(resolve({ 'Fn::If': ['HasList', 'yes', 'no'] }, c2)).toBe('yes');
  });

  it('Fn::FindInMap resolves an existing path, else UNRESOLVED (incl. unresolvable key)', () => {
    const c = ctx({ mappings: { RegionMap: { 'us-east-1': { ami: 'ami-123' } } } });
    expect(resolve({ 'Fn::FindInMap': ['RegionMap', { Ref: 'AWS::Region' }, 'ami'] }, c)).toBe(
      'ami-123'
    );
    // missing second key -> fail-closed
    expect(resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'nope'] }, c)).toBe(UNRESOLVED);
    // a key that can't resolve to a string -> fail-closed (never fabricate)
    expect(resolve({ 'Fn::FindInMap': ['RegionMap', { Ref: 'Ghost' }, 'ami'] }, c)).toBe(
      UNRESOLVED
    );
  });

  it('Fn::FindInMap honors the optional 4th DefaultValue when the path is absent', () => {
    const c = ctx({ mappings: { RegionMap: { 'us-east-1': { ami: 'ami-123' } } } });
    // missing path + DefaultValue -> the declared default (not UNRESOLVED)
    expect(
      resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'nope', { DefaultValue: 'fb' }] }, c)
    ).toBe('fb');
    // present path still wins over the default
    expect(
      resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'ami', { DefaultValue: 'fb' }] }, c)
    ).toBe('ami-123');
    // the default may itself be an intrinsic
    expect(
      resolve({ 'Fn::FindInMap': ['Ghost', 'x', 'y', { DefaultValue: { Ref: 'Env' } }] }, c)
    ).toBe('prod');
    // an unresolvable default stays fail-closed
    expect(
      resolve({ 'Fn::FindInMap': ['Ghost', 'x', 'y', { DefaultValue: { Ref: 'Nope' } }] }, c)
    ).toBe(UNRESOLVED);
  });

  it('Fn::FindInMap stringifies a numeric-/boolean-literal key argument (#1075)', () => {
    // YAML 1.1 turns `!FindInMap [AcctMap, 123456789012, Bucket]` into a JS number.
    // Mappings keys are always strings, so the numeric key must stringify and look up
    // the value rather than fail the string-type check (which left it UNRESOLVED).
    const c = ctx({
      mappings: {
        AcctMap: { '123456789012': { Bucket: 'my-bucket' } },
        FlagMap: { true: { Port: '443' } },
        RegionMap: { 'us-east-1': { '80': 'http' } },
      },
    });
    // numeric TopLevelKey
    expect(resolve({ 'Fn::FindInMap': ['AcctMap', 123456789012, 'Bucket'] }, c)).toBe('my-bucket');
    // boolean TopLevelKey (YAML 1.1 `yes`/`no`/`on`/`off`)
    expect(resolve({ 'Fn::FindInMap': ['FlagMap', true, 'Port'] }, c)).toBe('443');
    // numeric SecondLevelKey
    expect(resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 80] }, c)).toBe('http');
    // a genuinely-unresolved key argument still fails closed (not stringified)
    expect(resolve({ 'Fn::FindInMap': ['AcctMap', { Ref: 'Ghost' }, 'Bucket'] }, c)).toBe(
      UNRESOLVED
    );
  });

  it('Fn::Split splits a resolved string, propagates UNRESOLVED', () => {
    expect(resolve({ 'Fn::Split': [',', 'a,b,c'] }, ctx())).toEqual(['a', 'b', 'c']);
    expect(resolve({ 'Fn::Split': [',', { Ref: 'Env' }] }, ctx())).toEqual(['prod']);
    // unresolvable source -> fail-closed
    expect(resolve({ 'Fn::Split': [',', { Ref: 'Ghost' }] }, ctx())).toBe(UNRESOLVED);
  });

  it('Fn::ImportValue resolves a prefetched export, else UNRESOLVED', () => {
    const c = ctx({ exports: { SharedArn: 'arn:aws:x:::shared' } });
    expect(resolve({ 'Fn::ImportValue': 'SharedArn' }, c)).toBe('arn:aws:x:::shared');
    // export not present -> fail-closed (never fabricate)
    expect(resolve({ 'Fn::ImportValue': 'Missing' }, c)).toBe(UNRESOLVED);
    // name itself unresolvable -> fail-closed
    expect(resolve({ 'Fn::ImportValue': { Ref: 'Ghost' } }, c)).toBe(UNRESOLVED);
  });

  it('Fn::Sub treats ${!Literal} as a literal ${Literal} (no resolution)', () => {
    expect(resolve({ 'Fn::Sub': 'a-${!Literal}-${Env}' }, ctx())).toBe('a-${Literal}-prod');
  });

  it('FAIL-CLOSED: Fn::Select out-of-range index / unresolved element → UNRESOLVED', () => {
    expect(resolve({ 'Fn::Select': [1, ['a', 'b']] }, ctx())).toBe('b'); // in-range ok
    expect(resolve({ 'Fn::Select': [5, ['a', 'b']] }, ctx())).toBe(UNRESOLVED); // OOB
    expect(resolve({ 'Fn::Select': [0, [{ Ref: 'Ghost' }, 'b']] }, ctx())).toBe(UNRESOLVED); // unresolved element
  });

  it('Fn::Select resolves an intrinsic index (CFn allows Ref/FindInMap as the index)', () => {
    const c = ctx({ params: { Env: 'prod', Idx: '1' } });
    // index is a Ref to a (numeric-string) param -> resolved, then selected
    expect(resolve({ 'Fn::Select': [{ Ref: 'Idx' }, ['a', 'b', 'c']] }, c)).toBe('b');
    // a string-literal index still works
    expect(resolve({ 'Fn::Select': ['2', ['a', 'b', 'c']] }, c)).toBe('c');
    // an unresolvable index stays fail-closed (no throw on the UNRESOLVED symbol)
    expect(resolve({ 'Fn::Select': [{ Ref: 'Ghost' }, ['a', 'b']] }, c)).toBe(UNRESOLVED);
  });

  it('hasUnresolved detects sentinel at depth', () => {
    expect(hasUnresolved({ a: { b: [UNRESOLVED] } })).toBe(true);
    expect(hasUnresolved({ a: 1 })).toBe(false);
    expect(NOVALUE).toBeTypeOf('symbol');
  });

  // R130: a CloudFormation dynamic reference (`{{resolve:…}}`) is resolved by CFn at
  // deploy time to a live SSM/Secrets value cdkrd cannot know, so the declared side is
  // unknowable and must be UNRESOLVED (the same fail-closed treatment as Fn::GetAtt) —
  // otherwise an RDS MasterUsername declared as a secretsmanager dynamic ref reports
  // false drift against the resolved live `admin`.
  it('R130: dynamic reference {{resolve:…}} → UNRESOLVED', () => {
    const secret =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:111111111111:secret:Db-abc:SecretString:username::}}';
    expect(resolve(secret, ctx())).toBe(UNRESOLVED);
    expect(resolve('{{resolve:ssm:/my/param:1}}', ctx())).toBe(UNRESOLVED);
    expect(resolve('{{resolve:ssm-secure:/my/secure:5}}', ctx())).toBe(UNRESOLVED);
    // nested inside a properties object, MasterUsername becomes UNRESOLVED
    const props = resolveProperties({ MasterUsername: secret, Engine: 'mysql' }, ctx());
    expect(props.MasterUsername).toBe(UNRESOLVED);
    expect(props.Engine).toBe('mysql');
  });

  it('R130: an Fn::Join that ASSEMBLES a dynamic reference resolves to UNRESOLVED', () => {
    // exactly how CDK synthesizes an RDS MasterUsername from a generated secret:
    const join = {
      'Fn::Join': [
        '',
        ['{{resolve:secretsmanager:', { Ref: 'MyBucket' }, ':SecretString:username::}}'],
      ],
    };
    expect(resolve(join, ctx())).toBe(UNRESOLVED);
    // and via Fn::Sub
    expect(
      resolve(
        { 'Fn::Sub': '{{resolve:secretsmanager:${MyBucket}:SecretString:username::}}' },
        ctx()
      )
    ).toBe(UNRESOLVED);
    // a non-dynamic-reference Join still resolves normally
    expect(resolve({ 'Fn::Join': ['-', ['a', { Ref: 'Env' }]] }, ctx())).toBe('a-prod');
  });

  // #1073: a whole-string dynamic reference that arrives INDIRECTLY — produced by
  // resolving a Ref-to-parameter / Fn::FindInMap / Fn::Select / Fn::ImportValue rather
  // than as a direct string literal in the tree — must ALSO fold to UNRESOLVED. The
  // literal-string guard only sees a token that appears directly in the template; the
  // #722 fix guarded the direct case, this covers its indirect siblings. Leaking the
  // raw `{{resolve:…}}` here is a declared FP that prints the secret and, on revert,
  // writes the literal token back.
  it('R130 #1073: a dynamic reference resolved via Ref/FindInMap/Select/ImportValue → UNRESOLVED', () => {
    const secret =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:111111111111:secret:Db-abc:SecretString:username::}}';
    const ssm = '{{resolve:ssm-secure:/my/secure:5}}';

    // (a) Ref to a parameter whose value IS the dynamic-ref string.
    expect(resolve({ Ref: 'SecretRef' }, ctx({ params: { SecretRef: secret } }))).toBe(UNRESOLVED);

    // (b) Fn::FindInMap looked-up value is a dynamic-ref string.
    const mapCtx = ctx({ mappings: { M: { top: { key: ssm } } } });
    expect(resolve({ 'Fn::FindInMap': ['M', 'top', 'key'] }, mapCtx)).toBe(UNRESOLVED);
    // ...and via the FindInMap DefaultValue (map path absent) resolving to one.
    expect(
      resolve(
        { 'Fn::FindInMap': ['M', 'nope', 'nope', { DefaultValue: { Ref: 'SecretRef' } }] },
        ctx({ mappings: { M: {} }, params: { SecretRef: secret } })
      )
    ).toBe(UNRESOLVED);

    // (c) Fn::Select of a list containing the dynamic-ref string.
    expect(resolve({ 'Fn::Select': [1, ['a', secret, 'c']] }, ctx())).toBe(UNRESOLVED);

    // (d) Fn::ImportValue resolving to a dynamic-ref export.
    expect(
      resolve({ 'Fn::ImportValue': 'SecretExport' }, ctx({ exports: { SecretExport: ssm } }))
    ).toBe(UNRESOLVED);

    // no-regression: an ordinary (non-dynamic-ref) resolved string still resolves normally.
    expect(resolve({ Ref: 'Env' }, ctx())).toBe('prod');
    expect(
      resolve(
        { 'Fn::FindInMap': ['M', 'top', 'key'] },
        ctx({ mappings: { M: { top: { key: 'plain' } } } })
      )
    ).toBe('plain');
    expect(resolve({ 'Fn::Select': [0, ['first', 'second']] }, ctx())).toBe('first');
    expect(
      resolve({ 'Fn::ImportValue': 'PlainExport' }, ctx({ exports: { PlainExport: 'plain-val' } }))
    ).toBe('plain-val');
  });

  // #851: a malformed Fn::Sub argument (non-string / non-`[string, map]` array) must
  // fail closed to UNRESOLVED, never throw a TypeError on `.replace` of a non-string
  // template. Every branch of the resolver is fail-closed; these shapes were the gap.
  it('#851: malformed Fn::Sub shapes → UNRESOLVED (no throw)', () => {
    expect(resolve({ 'Fn::Sub': 5 }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Sub': null }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Sub': {} }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Sub': [] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Sub': [5, {}] }, ctx())).toBe(UNRESOLVED);
    // a well-formed [string, map] still resolves (regression guard)
    expect(resolve({ 'Fn::Sub': ['x-${V}', { V: 'ok' }] }, ctx())).toBe('x-ok');
  });

  // #851: the Fn::Join delimiter is used raw via `parts.join(delim)`. CFn requires a
  // LITERAL string delimiter; a non-string delimiter FABRICATES a declared value
  // (`join({Ref:…})` → "a[object Object]b", `join(0)` → "a0b") — worse than UNRESOLVED.
  it('#851: non-string Fn::Join delimiter → UNRESOLVED (no fabricated value)', () => {
    expect(resolve({ 'Fn::Join': [{ Ref: 'AWS::Region' }, ['a', 'b']] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Join': [0, ['a', 'b']] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Join': [null, ['a', 'b']] }, ctx())).toBe(UNRESOLVED);
    // a literal-string delimiter still resolves (regression guard)
    expect(resolve({ 'Fn::Join': ['-', ['a', 'b']] }, ctx())).toBe('a-b');
  });

  // #852: Fn::GetAtt has a long-form STRING argument in JSON (`{"Fn::GetAtt": "Bucket.Arn"}`),
  // split on the FIRST dot into [logicalId, attrPath]; attribute names may contain dots
  // (Outputs.X). A no-dot string has no attribute → UNRESOLVED.
  it('#852: Fn::GetAtt long-form STRING argument resolves against live attrs', () => {
    const c = ctx({
      liveAttrs: { Bucket: { Arn: 'arn:aws:s3:::b' }, Db: { Endpoint: { Address: 'h' } } },
    });
    expect(resolve({ 'Fn::GetAtt': 'Bucket.Arn' }, c)).toBe('arn:aws:s3:::b');
    // dotted attribute (split only on the FIRST dot)
    expect(resolve({ 'Fn::GetAtt': 'Db.Endpoint.Address' }, c)).toBe('h');
    // a no-dot string has no attribute → UNRESOLVED
    expect(resolve({ 'Fn::GetAtt': 'Bucket' }, c)).toBe(UNRESOLVED);
    // string form + nested Stack Outputs.<key> path
    const nested = ctx({
      typeOf: { Nested: 'AWS::CloudFormation::Stack' },
      liveAttrs: { Nested: { Outputs: [{ OutputKey: 'BucketArn', OutputValue: 'arn:x' }] } },
    });
    expect(resolve({ 'Fn::GetAtt': 'Nested.Outputs.BucketArn' }, nested)).toBe('arn:x');
  });

  // #854: Fn::Cidr [ipBlock, count, cidrBits] is a deterministic pure IPv4 function.
  // cidrBits is subnet bits from the RIGHT: block size 2^cidrBits, mask = 32 - cidrBits.
  it('#854: Fn::Cidr splits a block into the documented subnet array', () => {
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/16', 6, 8] }, ctx())).toEqual([
      '10.0.0.0/24',
      '10.0.1.0/24',
      '10.0.2.0/24',
      '10.0.3.0/24',
      '10.0.4.0/24',
      '10.0.5.0/24',
    ]);
    // a single /28 subnet (cidrBits=4 → 16 addresses → mask /28)
    expect(resolve({ 'Fn::Cidr': ['192.168.0.0/24', 1, 4] }, ctx())).toEqual(['192.168.0.0/28']);
  });

  it('#854: Fn::Cidr nests inside Fn::Select (a subnet CidrBlock declaration)', () => {
    expect(resolve({ 'Fn::Select': [0, { 'Fn::Cidr': ['10.0.0.0/16', 6, 8] }] }, ctx())).toBe(
      '10.0.0.0/24'
    );
    expect(resolve({ 'Fn::Select': [3, { 'Fn::Cidr': ['10.0.0.0/16', 6, 8] }] }, ctx())).toBe(
      '10.0.3.0/24'
    );
  });

  it('#854: Fn::Cidr fails closed on out-of-range / malformed / IPv6 / unresolved args', () => {
    // count too large for the block (256 /24 subnets is the max in a /16; 300 overflows)
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/16', 300, 8] }, ctx())).toBe(UNRESOLVED);
    // subnet mask coarser than the block prefix (a /16 subnet inside a /24 block)
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/24', 1, 16] }, ctx())).toBe(UNRESOLVED);
    // invalid CIDR / octet out of range / no slash
    expect(resolve({ 'Fn::Cidr': ['10.0.0.999/16', 1, 8] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0', 1, 8] }, ctx())).toBe(UNRESOLVED);
    // IPv6 not resolved
    expect(resolve({ 'Fn::Cidr': ['2001:db8::/32', 1, 64] }, ctx())).toBe(UNRESOLVED);
    // an unresolved arg propagates (a Ref to a missing param)
    expect(resolve({ 'Fn::Cidr': [{ Ref: 'Ghost' }, 6, 8] }, ctx())).toBe(UNRESOLVED);
    // malformed shape (not a 3-arg array)
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/16', 6] }, ctx())).toBe(UNRESOLVED);
  });

  // #902: hardening — an UNRESOLVED count/cidrBits must not reach Number() (it throws on the
  // Symbol and killed the whole check with exit 2), and a non-network-aligned ipBlock must
  // fail closed rather than fabricate wrong CIDRs.
  it('#902: an UNRESOLVED count/cidrBits/ipBlock fails closed, never throws', () => {
    // count as a first-pass Fn::GetAtt (Fn.cidr(vpc.attrCidrBlock, ...) count from a GetAtt):
    // resolve() returns the UNRESOLVED Symbol; Number(Symbol) would throw TypeError.
    expect(() =>
      resolve({ 'Fn::Cidr': ['10.0.0.0/16', { 'Fn::GetAtt': ['X', 'Y'] }, 8] }, ctx())
    ).not.toThrow();
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/16', { 'Fn::GetAtt': ['X', 'Y'] }, 8] }, ctx())).toBe(
      UNRESOLVED
    );
    // cidrBits UNRESOLVED
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/16', 6, { 'Fn::GetAtt': ['X', 'Y'] }] }, ctx())).toBe(
      UNRESOLVED
    );
    // ipBlock UNRESOLVED (a GetAtt that yields a Symbol rather than a non-string scalar)
    expect(resolve({ 'Fn::Cidr': [{ 'Fn::GetAtt': ['X', 'Y'] }, 6, 8] }, ctx())).toBe(UNRESOLVED);
  });

  it('#902: a non-network-aligned ipBlock (host bits set) fails closed', () => {
    // base starts at a host address, not the /24 network address → fail closed, do not
    // fabricate ["10.0.0.128/28", ...].
    expect(resolve({ 'Fn::Cidr': ['10.0.0.128/24', 2, 4] }, ctx())).toBe(UNRESOLVED);
    // 16 /28 subnets from a host base would run past the /24 → fail closed.
    expect(resolve({ 'Fn::Cidr': ['10.0.0.128/24', 16, 4] }, ctx())).toBe(UNRESOLVED);
    // any host bits set are rejected (not silently aligned down to 10.0.0.0/28).
    expect(resolve({ 'Fn::Cidr': ['10.0.0.3/24', 2, 4] }, ctx())).toBe(UNRESOLVED);
    // a correctly network-aligned block still resolves.
    expect(resolve({ 'Fn::Cidr': ['10.0.0.0/24', 2, 4] }, ctx())).toEqual([
      '10.0.0.0/28',
      '10.0.0.16/28',
    ]);
  });

  it('R130: isDynamicReference matches only real dynamic-reference tokens', () => {
    expect(isDynamicReference('{{resolve:secretsmanager:my-secret:SecretString:user::}}')).toBe(
      true
    );
    expect(isDynamicReference('{{resolve:ssm:/p:1}}')).toBe(true);
    expect(isDynamicReference('{{resolve:ssm-secure:/p:1}}')).toBe(true);
    // not a dynamic reference: plain values, other intrinsics, partial/embedded tokens
    expect(isDynamicReference('admin')).toBe(false);
    expect(isDynamicReference('{{resolve:other:x}}')).toBe(false);
    expect(isDynamicReference('prefix-{{resolve:ssm:/p:1}}')).toBe(false);
    expect(isDynamicReference('{{resolve:ssm:/p:1}}-suffix')).toBe(false);
    expect(isDynamicReference('')).toBe(false);
  });

  it('#722: containsDynamicReference matches an EMBEDDED well-formed token', () => {
    // whole-string (subset of contains) still matches
    expect(containsDynamicReference('{{resolve:secretsmanager:s:SecretString:pw::}}')).toBe(true);
    expect(containsDynamicReference('{{resolve:ssm:/p:1}}')).toBe(true);
    expect(containsDynamicReference('{{resolve:ssm-secure:/p:1}}')).toBe(true);
    // embedded in a larger literal (the connection-string pattern)
    expect(
      containsDynamicReference(
        'postgres://admin:{{resolve:secretsmanager:MySecret:SecretString:password}}@host:5432/db'
      )
    ).toBe(true);
    expect(containsDynamicReference('prefix-{{resolve:ssm:/p:1}}')).toBe(true);
    expect(containsDynamicReference('{{resolve:ssm:/p:1}}-suffix')).toBe(true);
    // NEGATIVE: no valid service + closing `}}` completion → not muted
    expect(containsDynamicReference('admin')).toBe(false);
    expect(containsDynamicReference('see {{resolve later}}')).toBe(false);
    expect(containsDynamicReference('{{resolve:unknownsvc:x}}')).toBe(false);
    expect(containsDynamicReference('a bare {{resolve fragment')).toBe(false);
    expect(containsDynamicReference('')).toBe(false);
  });

  it('#722: an EMBEDDED dynamic reference in a larger literal string → UNRESOLVED', () => {
    // connection-string pattern: a declared literal carrying an embedded token is
    // deploy-time-transformed, so its final value is unknowable → UNRESOLVED (not a
    // literal declared value that would falsely diverge from the resolved live value).
    expect(
      resolve(
        'postgres://admin:{{resolve:secretsmanager:MySecret:SecretString:password}}@host:5432/db',
        ctx()
      )
    ).toBe(UNRESOLVED);
    // whole-string still UNRESOLVED (no regression).
    expect(resolve('{{resolve:secretsmanager:MySecret:SecretString:password}}', ctx())).toBe(
      UNRESOLVED
    );
    // a nested property carrying an embedded token folds to UNRESOLVED at that leaf.
    expect(
      resolve(
        { ConnStr: 'redis://{{resolve:ssm-secure:/db/pw:1}}@r.example.com', Port: 6379 },
        ctx()
      )
    ).toEqual({ ConnStr: UNRESOLVED, Port: 6379 });
  });

  it('#722: a dynamic reference EMBEDDED via Fn::Join → UNRESOLVED', () => {
    // Join assembles a token INTO surrounding literal text (a connection string) — the
    // assembled result is a deploy-time dynamic reference → UNRESOLVED.
    expect(
      resolve(
        {
          'Fn::Join': [
            '',
            [
              'postgres://admin:',
              '{{resolve:secretsmanager:MySecret:SecretString:password}}',
              '@host:5432/db',
            ],
          ],
        },
        ctx()
      )
    ).toBe(UNRESOLVED);
  });

  it('#722: a dynamic reference EMBEDDED via Fn::Sub → UNRESOLVED', () => {
    // Sub interpolates around an embedded token in a larger literal → UNRESOLVED.
    expect(
      resolve(
        {
          'Fn::Sub': [
            'postgres://admin:{{resolve:secretsmanager:MySecret:SecretString:password}}@${Host}/db',
            { Host: 'db.example.com' },
          ],
        },
        ctx()
      )
    ).toBe(UNRESOLVED);
  });

  // #1329: CloudFormation REMOVES a list element whose value resolves to AWS::NoValue,
  // so the list COMPACTS and later indices shift BEFORE Fn::Select runs. The resolver
  // already mirrors that compaction in Fn::Join and pruneNoValue, but Fn::Select
  // indexed the RAW resolved array: an index after the NoValue slot selected the WRONG
  // element (a fabricated declared value → false [Declared Drift], and revert writes
  // the wrong value back), and an index AT the slot returned the NOVALUE symbol, which
  // pruneNoValue then deleted as the whole declared property.
  it('#1329: Fn::Select indexes the COMPACTED list (AWS::NoValue elements removed first)', () => {
    const c = ctx({
      params: { Env: 'dev' }, // IsProd=false → the Fn::If element resolves to NOVALUE
      conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
    });
    // index AFTER the NoValue slot: CFn compacts to ['b','c'], so index 1 is 'c' (was 'b')
    expect(
      resolve(
        {
          'Fn::Select': [
            1,
            [{ 'Fn::If': ['IsProd', 'prod-only', { Ref: 'AWS::NoValue' }] }, 'b', 'c'],
          ],
        },
        c
      )
    ).toBe('c');
    // index AT the NoValue slot: compacted[0] is 'y' — previously the NOVALUE symbol
    // leaked out and pruneNoValue deleted the whole declared property.
    expect(
      resolveProperties(
        {
          Port: {
            'Fn::Select': [0, [{ 'Fn::If': ['IsProd', 'x', { Ref: 'AWS::NoValue' }] }, 'y']],
          },
        },
        c
      )
    ).toEqual({ Port: 'y' });
    // the bounds check runs against the COMPACTED length: selecting past it fails
    // closed (previously the raw length let a wrong element through).
    expect(resolve({ 'Fn::Select': [1, [{ Ref: 'AWS::NoValue' }, 'only']] }, ctx())).toBe(
      UNRESOLVED
    );
    // a list WITHOUT NoValue is unchanged (regression guard; Fn::Join compaction is
    // pinned separately above).
    expect(resolve({ 'Fn::Select': [1, ['a', 'b']] }, ctx())).toBe('b');
  });

  // #1331: the #1073 re-check of an intrinsic-PRODUCED value was gated on
  // `typeof r === 'string'`, so a produced ARRAY passed through with its elements
  // uninspected — a `{{resolve:…}}` ELEMENT inside a CommaDelimitedList/List<>
  // parameter value or an Fn::FindInMap list value leaked out (false declared drift
  // that prints the secret token and, on revert, writes the literal token to AWS).
  // The whole container fails closed to UNRESOLVED (per-element muting would
  // fabricate a list whose shape differs from live), matching the scalar precedent.
  it('#1331: a dynamic-ref ELEMENT inside a produced list → whole value UNRESOLVED', () => {
    const ssm = '{{resolve:ssm:/prod/extra-sg}}';
    // (a) Ref to a CommaDelimitedList/List<> parameter carrying a token element
    //     (buildResolverContext.toParam splits 'sg-aaa,{{resolve:…}}' into this array).
    expect(resolve({ Ref: 'SgList' }, ctx({ params: { SgList: ['sg-aaa', ssm] } }))).toBe(
      UNRESOLVED
    );
    // (b) Fn::FindInMap whose looked-up value is a LIST with a token element.
    expect(
      resolve(
        { 'Fn::FindInMap': ['M', 'top', 'key'] },
        ctx({ mappings: { M: { top: { key: ['sg-aaa', ssm] } } } })
      )
    ).toBe(UNRESOLVED);
    // controls: the SCALAR cases stay muted exactly as before (#1073).
    expect(
      resolve(
        { 'Fn::FindInMap': ['M', 'top', 'key'] },
        ctx({ mappings: { M: { top: { key: ssm } } } })
      )
    ).toBe(UNRESOLVED);
    expect(resolve({ Ref: 'Secret' }, ctx({ params: { Secret: ssm } }))).toBe(UNRESOLVED);
    // controls: plain lists WITHOUT tokens still resolve normally (no over-muting).
    expect(resolve({ Ref: 'SgList' }, ctx({ params: { SgList: ['sg-aaa', 'sg-bbb'] } }))).toEqual([
      'sg-aaa',
      'sg-bbb',
    ]);
    expect(
      resolve(
        { 'Fn::FindInMap': ['M', 'top', 'key'] },
        ctx({ mappings: { M: { top: { key: ['a', 'b'] } } } })
      )
    ).toEqual(['a', 'b']);
  });

  it('#722 NEGATIVE: a literal that merely contains `{{resolve` without a valid token is NOT muted', () => {
    // no valid <service> + closing `}}` completion → stays a literal declared value.
    expect(resolve('see {{resolve later}}', ctx())).toBe('see {{resolve later}}');
    expect(resolve('{{resolve:unknownsvc:x}}', ctx())).toBe('{{resolve:unknownsvc:x}}');
    // a plain literal with no token is unchanged.
    expect(resolve('just-a-plain-value', ctx())).toBe('just-a-plain-value');
  });
});

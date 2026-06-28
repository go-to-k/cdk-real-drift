import { describe, expect, it } from 'vite-plus/test';
import {
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
});

import { describe, expect, it } from 'vite-plus/test';
import { detectTemplateFormat, parseCfnTemplate } from '../src/desired/yaml-cfn.js';

describe('yaml-cfn parse', () => {
  it('detects format by first non-space char', () => {
    expect(detectTemplateFormat('{"a":1}')).toBe('json');
    expect(detectTemplateFormat('Resources:\n  X: {}')).toBe('yaml');
  });

  it('parses JSON templates', () => {
    expect(parseCfnTemplate('{"Resources":{"B":{"Type":"AWS::S3::Bucket"}}}')).toEqual({
      Resources: { B: { Type: 'AWS::S3::Bucket' } },
    });
  });

  it('parses YAML with shorthand intrinsics into long-form', () => {
    const t = parseCfnTemplate(`Resources:
  B:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Ref MyParam
      Other: !Sub "x-\${AWS::Region}"
      Att: !GetAtt Foo.Arn
      Cond: !If [C, a, b]`);
    const p = (t as any).Resources.B.Properties;
    expect(p.BucketName).toEqual({ Ref: 'MyParam' });
    expect(p.Other).toEqual({ 'Fn::Sub': 'x-${AWS::Region}' });
    expect(p.Att).toEqual({ 'Fn::GetAtt': ['Foo', 'Arn'] });
    expect(p.Cond).toEqual({ 'Fn::If': ['C', 'a', 'b'] });
  });

  it('resolves multi-letter YAML 1.1 booleans, matching CloudFormation (#785)', () => {
    // CloudFormation's service-side parser resolves YAML 1.1, not yaml@2's default
    // 1.2 core schema. Under 1.2 `yes`/`no`/`on`/`off` stay strings; CFn folds the
    // multi-letter forms to boolean, and cdkrd must match what CFn deployed. (The
    // YAML-1.1-only NUMBER spellings `0755`/`1:30` are NOT numbers to CFn — it keeps
    // them as strings; see the octal/hex/float-special/sexagesimal test below, #1053.)
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      YesVal: yes
      NoVal: no
      OnVal: on
      OffVal: off`);
    const p = (t as any).Resources.R.Properties;
    expect(p.YesVal).toBe(true); // 1.2 -> "yes"
    expect(p.NoVal).toBe(false); // 1.2 -> "no"
    expect(p.OnVal).toBe(true); // 1.2 -> "on"
    expect(p.OffVal).toBe(false); // 1.2 -> "off"
  });

  it('keeps a quoted leading-zero account id a string (no revert corruption, #785)', () => {
    // The common shape for an account id in a template is a quoted string, which stays
    // a string under both schemas. The BARE form is covered by the #1053 test below
    // (the restricted `int` tag no longer coerces a leading-zero scalar to a number);
    // the quoted form is what must never silently lose its leading zero on parse ->
    // revert round-trip regardless.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      Account: "012345678901"`);
    const p = (t as any).Resources.R.Properties;
    expect(p.Account).toBe('012345678901');
    expect(typeof p.Account).toBe('string');
  });

  it('keeps an unquoted date-like plain scalar a string, not a Date (#850)', () => {
    // The stock yaml@2 YAML-1.1 schema resolves an unquoted date-like scalar to a JS
    // `Date` object via the implicit `!!timestamp` tag — but CloudFormation deploys it
    // verbatim as a string. A `Date` compared against the live string is a declared
    // false positive that survives `record` and corrupts `revert`. It must stay a string.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      ExpirationDate: 2026-01-01
      Ver: 2010-09-09
      Ts: 2001-12-14 21:59:43.10 -5`);
    const p = (t as any).Resources.R.Properties;
    expect(p.ExpirationDate).toBe('2026-01-01');
    expect(p.ExpirationDate instanceof Date).toBe(false);
    expect(p.Ver).toBe('2010-09-09');
    expect(p.Ver instanceof Date).toBe(false);
    expect(p.Ts).toBe('2001-12-14 21:59:43.10 -5');
    expect(p.Ts instanceof Date).toBe(false);
  });

  it('keeps an EXPLICIT !!timestamp scalar a string, not a Date (#909)', () => {
    // #860 dropped the implicit timestamp resolver, but yaml@2 still resolved the
    // EXPLICIT `!!timestamp` form through its `knownTags` fallback — `P: !!timestamp
    // 2026-01-01` produced a JS `Date`, not a string. CloudFormation deploys the scalar
    // verbatim as a string; a `Date` compared against the live string is a declared
    // false positive that survives `record` and corrupts `revert`. It must stay a string.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      ExpirationDate: !!timestamp 2026-01-01
      Ver: !!timestamp 2010-09-09
      Ts: !!timestamp 2001-12-14T21:59:43.10-05:00`);
    const p = (t as any).Resources.R.Properties;
    expect(p.ExpirationDate).toBe('2026-01-01');
    expect(p.ExpirationDate instanceof Date).toBe(false);
    expect(p.Ver).toBe('2010-09-09');
    expect(p.Ver instanceof Date).toBe(false);
    expect(p.Ts).toBe('2001-12-14T21:59:43.10-05:00');
    expect(p.Ts instanceof Date).toBe(false);
  });

  it('keeps a single-letter Y/N plain scalar a string, not a boolean (#850)', () => {
    // The YAML 1.1 `bool` regex includes single letters `Y|y|N|n`, so a bare
    // `AttributeType: N` resolves to boolean `false` and `Y` to `true`. CloudFormation
    // does NOT do this (a DynamoDB AttributeType `N`/`S`/`B` deploys as the string).
    // A boolean compared against the live string is a declared false positive.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::DynamoDB::Table
    Properties:
      AttrN: N
      AttrY: Y
      AttrLowerN: n
      AttrLowerY: y`);
    const p = (t as any).Resources.R.Properties;
    expect(p.AttrN).toBe('N');
    expect(p.AttrY).toBe('Y');
    expect(p.AttrLowerN).toBe('n');
    expect(p.AttrLowerY).toBe('y');
  });

  it('still resolves multi-letter booleans and plain numbers under the restricted 1.1 schema (#785 preserved)', () => {
    // The #850/#909/#1053 restrictions (drop implicit/explicit timestamps, exclude
    // single-letter bools, restrict int/float to plain JSON numbers) must NOT regress
    // the #785 fix: multi-letter YAML 1.1 booleans and plain decimal / float / scientific
    // numbers must still resolve exactly as CloudFormation produces them.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      YesVal: yes
      NoVal: no
      OnVal: on
      OffVal: off
      TrueVal: true
      FalseVal: false
      Int: 12345
      NegInt: -7
      Float: -3.5
      Sci: 5e3`);
    const p = (t as any).Resources.R.Properties;
    expect(p.YesVal).toBe(true);
    expect(p.NoVal).toBe(false);
    expect(p.OnVal).toBe(true);
    expect(p.OffVal).toBe(false);
    expect(p.TrueVal).toBe(true);
    expect(p.FalseVal).toBe(false);
    expect(p.Int).toBe(12345);
    expect(p.NegInt).toBe(-7);
    expect(p.Float).toBe(-3.5);
    expect(p.Sci).toBe(5000);
  });

  it('keeps octal/hex/binary/sexagesimal/float-special/leading-zero scalars strings, not coerced numbers (#1053)', () => {
    // yaml@2's YAML-1.1 `int`/`float` tags resolve these plain scalars to numbers (or
    // Infinity), but CloudFormation keeps them as STRINGS. Coercing them is a declared
    // false positive that survives `record`, and `revert` then writes the corrupted
    // number back — a garbage account id from octal `012345670123` -> 1402433619, or
    // `null` from `.inf` -> Infinity. Each must stay the exact source string.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      OctalAccount: 012345670123
      Mode: 0777
      Hex: 0x1A2B
      Binary: 0b1010
      Sexagesimal: 1:30
      Inf: .inf
      NegInf: -.inf
      NaN: .nan
      Underscored: 1_000
      LeadingZero: 000123456789`);
    const p = (t as any).Resources.R.Properties;
    expect(p.OctalAccount).toBe('012345670123'); // NOT 1402433619
    expect(typeof p.OctalAccount).toBe('string');
    expect(p.Mode).toBe('0777'); // NOT 511
    expect(p.Hex).toBe('0x1A2B'); // NOT 6699
    expect(p.Binary).toBe('0b1010'); // NOT 10
    expect(p.Sexagesimal).toBe('1:30'); // NOT 90
    expect(p.Inf).toBe('.inf'); // NOT Infinity (JSON.stringify -> null)
    expect(Number.isFinite(p.Inf)).toBe(false);
    expect(typeof p.Inf).toBe('string');
    expect(p.NegInf).toBe('-.inf'); // NOT -Infinity
    expect(typeof p.NegInf).toBe('string');
    expect(p.NaN).toBe('.nan'); // NOT NaN
    expect(typeof p.NaN).toBe('string');
    expect(p.Underscored).toBe('1_000'); // NOT 1000
    expect(typeof p.Underscored).toBe('string');
    expect(p.LeadingZero).toBe('000123456789'); // NOT 123456789
    expect(typeof p.LeadingZero).toBe('string');
    // JSON-serializable: a coerced Infinity/NaN would become null, corrupting revert.
    expect(() => JSON.parse(JSON.stringify(p))).not.toThrow();
    expect(JSON.parse(JSON.stringify(p)).Inf).toBe('.inf');
  });

  it('rejects a non-object root', () => {
    expect(() => parseCfnTemplate('[1,2]')).toThrow();
  });

  it('degrades a dot-less !GetAtt to a 1-element array instead of crashing the whole parse', () => {
    // A custom-tag resolve() that throws aborts the ENTIRE yaml parse — one malformed
    // !GetAtt would crash the whole stack check. It must degrade to UNRESOLVED-able
    // form (length 1 -> resolveGetAtt returns UNRESOLVED) and keep parsing the rest.
    const t = parseCfnTemplate(`Resources:
  B:
    Type: AWS::S3::Bucket
    Properties:
      Bad: !GetAtt JustALogicalId
      Good: !GetAtt Foo.Arn`);
    const p = (t as any).Resources.B.Properties;
    expect(p.Bad).toEqual({ 'Fn::GetAtt': ['JustALogicalId'] }); // 1-element -> UNRESOLVED downstream
    expect(p.Good).toEqual({ 'Fn::GetAtt': ['Foo', 'Arn'] }); // the rest still parses
  });
});

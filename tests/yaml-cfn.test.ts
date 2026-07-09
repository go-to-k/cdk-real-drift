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

  it('resolves implicit scalars with the YAML 1.1 schema, matching CloudFormation (#785)', () => {
    // CloudFormation's service-side parser resolves YAML 1.1, not yaml@2's default
    // 1.2 core schema. Under 1.2 these would FAIL: `yes`/`off` stay strings, `0755`
    // is decimal 755, `1:30` stays a string. cdkrd must match what CFn deployed.
    const t = parseCfnTemplate(`Resources:
  R:
    Type: AWS::Fake::Type
    Properties:
      YesVal: yes
      NoVal: no
      OnVal: on
      OffVal: off
      Mode: 0755
      Sexagesimal: 1:30`);
    const p = (t as any).Resources.R.Properties;
    expect(p.YesVal).toBe(true); // 1.2 -> "yes"
    expect(p.NoVal).toBe(false); // 1.2 -> "no"
    expect(p.OnVal).toBe(true); // 1.2 -> "on"
    expect(p.OffVal).toBe(false); // 1.2 -> "off"
    expect(p.Mode).toBe(493); // octal 0755; 1.2 -> 755
    expect(p.Sexagesimal).toBe(90); // 60*1 + 30; 1.2 -> "1:30"
  });

  it('keeps a quoted leading-zero account id a string (no revert corruption, #785)', () => {
    // The common shape for an account id in a template is a quoted string, which stays
    // a string under both schemas. A BARE `012345678901` is octal-invalid (digits 8/9)
    // so YAML 1.1 falls back to decimal — same as CFn — but the quoted form is what
    // must never silently lose its leading zero on parse -> revert round-trip.
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

  it('still resolves yes/no/on/off and octal/sexagesimal under the restricted 1.1 schema (#785 preserved)', () => {
    // The #850 restriction (drop implicit timestamps, exclude single-letter bools) must
    // NOT regress the #785 fix: multi-letter YAML 1.1 booleans and octal/sexagesimal
    // integers must still resolve exactly as CloudFormation's 1.1 parser produces them.
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
      Mode: 0755
      Sexagesimal: 1:30`);
    const p = (t as any).Resources.R.Properties;
    expect(p.YesVal).toBe(true);
    expect(p.NoVal).toBe(false);
    expect(p.OnVal).toBe(true);
    expect(p.OffVal).toBe(false);
    expect(p.TrueVal).toBe(true);
    expect(p.FalseVal).toBe(false);
    expect(p.Mode).toBe(493); // octal 0755
    expect(p.Sexagesimal).toBe(90); // 60*1 + 30
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

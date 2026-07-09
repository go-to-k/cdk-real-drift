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

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

import { describe, expect, it } from 'vite-plus/test';
import { unpreviewableParamInfo } from '../src/desired/template-adapter.js';

// #1296 — unpreviewableParamInfo scoped the "referenced by a declared property" set to
// template.Resources ONLY, so a no-value param referenced only through template.Conditions
// (a `Fn::If`-fed property, or a resource-level `Condition:` attribute) was never counted →
// the loud --pre-deploy warning silently returned null and the property fell into the generic
// unresolved footer. The fix unions the Conditions bodies into the referenced-name set.
describe('#1296 — unpreviewableParamInfo counts params referenced through Conditions', () => {
  it('warns for a no-value param referenced ONLY through a Condition (Fn::If)', () => {
    // `Env` has no Default and no deployed value; it is referenced only inside a Condition body
    // (`IsProd: Env == prod`), which then feeds a property via `Fn::If`. Before the fix, the
    // referenced set (Resources only) did not include `Env`, so this returned null.
    const template = {
      Parameters: { Env: { Type: 'String' } },
      Conditions: {
        IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] },
      },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            MemorySize: { 'Fn::If': ['IsProd', 1024, 128] },
          },
        },
      },
    };
    const note = unpreviewableParamInfo(template, {}, 'MyStack');
    expect(note).not.toBeNull();
    expect(note).toContain('Env');
    expect(note).toContain('MyStack');
  });

  it('control: a param referenced ONLY in Resources still warns (regression guard)', () => {
    const template = {
      Parameters: { BucketName: { Type: 'String' } },
      Resources: {
        Bkt: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: { Ref: 'BucketName' } },
        },
      },
    };
    const note = unpreviewableParamInfo(template, {}, 'MyStack');
    expect(note).not.toBeNull();
    expect(note).toContain('BucketName');
  });

  it('control: a param with a Default is excluded even if referenced through a Condition', () => {
    const template = {
      Parameters: { Env: { Type: 'String', Default: 'dev' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: { 'Fn::If': ['IsProd', 1024, 128] } },
        },
      },
    };
    expect(unpreviewableParamInfo(template, {}, 'MyStack')).toBeNull();
  });

  it('control: a NoEcho param referenced through a Condition is excluded (#744 treatment)', () => {
    const template = {
      Parameters: { Env: { Type: 'String', NoEcho: true } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: { 'Fn::If': ['IsProd', 1024, 128] } },
        },
      },
    };
    expect(unpreviewableParamInfo(template, {}, 'MyStack')).toBeNull();
  });

  it('control: an SSM Parameter::Value-typed param referenced through a Condition is excluded (#882)', () => {
    const template = {
      Parameters: { Env: { Type: 'AWS::SSM::Parameter::Value<String>' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: { 'Fn::If': ['IsProd', 1024, 128] } },
        },
      },
    };
    expect(unpreviewableParamInfo(template, {}, 'MyStack')).toBeNull();
  });
});

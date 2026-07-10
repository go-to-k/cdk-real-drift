import { describe, expect, it } from 'vite-plus/test';
import { buildResolverContext, unpreviewableParamInfo } from '../src/desired/template-adapter.js';

// #728: under --pre-deploy the declared source is the LOCAL synth template, so a param's
// LOCAL Default is authoritative. DescribeStacks returns an effective value for ALL params
// (incl. default-materialized ones), so overriding a CHANGED local Default with the deployed
// value masks exactly the drift --pre-deploy exists to preview. buildResolverContext takes a
// trailing `preDeploy` flag: when true the local Default wins and the deployed value only
// FILLS params that have no local Default.
describe('#728 — buildResolverContext --pre-deploy param resolution', () => {
  it('CHANGED local Default is masked by deployed value on the deployed path, but WINS under --pre-deploy', () => {
    const template = { Parameters: { Foo: { Default: 'NEW' } } };
    // Deployed path (preDeploy=false): deployed value wins (unchanged behaviour).
    const deployed = buildResolverContext(
      template,
      { Foo: 'OLD' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn'
      // preDeploy defaults to false
    );
    expect(deployed.params.Foo).toBe('OLD');
    // Pre-deploy path (preDeploy=true): the local Default is authoritative → the changed
    // Default is NOT masked, so the drift the next `cdk deploy` would apply is visible.
    const pre = buildResolverContext(
      template,
      { Foo: 'OLD' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn',
      true
    );
    expect(pre.params.Foo).toBe('NEW');
  });

  it('a param with NO local Default still resolves from the deployed value under --pre-deploy (fill step)', () => {
    // A required param (no Default) set at deploy time: we still need a value to resolve its
    // Refs, so the deployed value fills it even though the local Default does not win.
    const template = { Parameters: { Bar: { Type: 'String' } } };
    const pre = buildResolverContext(
      template,
      { Bar: 'deployedVal' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn',
      true
    );
    expect(pre.params.Bar).toBe('deployedVal');
  });

  it('preserves list typing of a local Default under --pre-deploy (CommaDelimitedList → array)', () => {
    // The local Default wins AND is still split/trimmed to an array, so an Fn::Join /
    // Fn::Select / condition over the list evaluates correctly.
    const template = { Parameters: { Csv: { Type: 'CommaDelimitedList', Default: 'a,b' } } };
    const pre = buildResolverContext(
      template,
      { Csv: 'x,y,z' }, // OLD deployed value must NOT override the local Default
      {},
      'us-east-1',
      '999',
      'S',
      'arn',
      true
    );
    expect(pre.params.Csv).toEqual(['a', 'b']);
  });

  it('NoEcho / SSM ::Parameter::Value< Default-skipping is unaffected under --pre-deploy (deployed value still applies)', () => {
    // These params are intentionally NOT seeded from their Default (the Default is a
    // placeholder / SSM key, not the real value). They are absent from `params`, so the
    // fill step still applies their deployed value under --pre-deploy — the same safe
    // treatment as the deployed path.
    const template = {
      Parameters: {
        Secret: { Type: 'String', NoEcho: true, Default: 'changeme' },
        Ssm: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/golden/ami' },
      },
    };
    const pre = buildResolverContext(
      template,
      { Secret: 'liveSecret', Ssm: 'ami-0abc' },
      {},
      'us-east-1',
      '999',
      'S',
      'arn',
      true
    );
    // The placeholder/key Default was NOT used; the deployed value filled it instead.
    expect(pre.params.Secret).toBe('liveSecret');
    expect(pre.params.Ssm).toBe('ami-0abc');
  });
});

// #728 case 1 / #1194: a new/renamed local param with no Default AND absent from the deployed
// stack has no value anywhere → every Ref to it resolves UNRESOLVED and the referencing
// declared property is silently "not compared". unpreviewableParamInfo surfaces that LOUDLY.
describe('#1215 — unpreviewableParamInfo (--pre-deploy no-value params)', () => {
  // The canonical trigger: a legacy-synth AssetParameters<newhash> param after an asset change.
  const assetTemplate = {
    Parameters: {
      AssetParametersDEADBEEFS3Bucket: { Type: 'String' },
      AssetParametersDEADBEEFS3VersionKey: { Type: 'String' },
    },
    Resources: {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Code: {
            S3Bucket: { Ref: 'AssetParametersDEADBEEFS3Bucket' },
            S3Key: { Ref: 'AssetParametersDEADBEEFS3VersionKey' },
          },
        },
      },
    },
  };

  it('emits a loud note naming a new referenced param with no Default and no deployed value', () => {
    const note = unpreviewableParamInfo(assetTemplate, {}, 'MyStack');
    expect(note).not.toBeNull();
    expect(note).toContain('MyStack');
    expect(note).toContain('cannot preview');
    expect(note).toContain('AssetParametersDEADBEEFS3Bucket');
    expect(note).toContain('AssetParametersDEADBEEFS3VersionKey');
    expect(note?.startsWith('warning:')).toBe(true);
  });

  it('is null when the param carries a local Default (resolvable — not a coverage gap)', () => {
    const template = {
      Parameters: { Foo: { Type: 'String', Default: 'x' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Foo' } } } },
    };
    expect(unpreviewableParamInfo(template, {}, 'S')).toBeNull();
  });

  it('is null when the deployed stack supplies the value (fill step resolves it)', () => {
    const template = {
      Parameters: { Foo: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Foo' } } } },
    };
    expect(unpreviewableParamInfo(template, { Foo: 'deployed' }, 'S')).toBeNull();
  });

  it('excludes NoEcho and SSM ::Parameter::Value< params (their own documented treatment)', () => {
    const template = {
      Parameters: {
        Secret: { Type: 'String', NoEcho: true },
        Ssm: { Type: 'AWS::SSM::Parameter::Value<String>' },
      },
      Resources: {
        R: {
          Type: 'AWS::SNS::Topic',
          Properties: { A: { Ref: 'Secret' }, B: { Ref: 'Ssm' } },
        },
      },
    };
    expect(unpreviewableParamInfo(template, {}, 'S')).toBeNull();
  });

  it('is null when the no-value param is not referenced by any declared property', () => {
    const template = {
      Parameters: { Unused: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'literal' } } },
    };
    expect(unpreviewableParamInfo(template, {}, 'S')).toBeNull();
  });

  it('counts an Fn::Sub ${Param} reference (and ignores the ${!Literal} escape)', () => {
    const template = {
      Parameters: { Env: { Type: 'String' }, Escaped: { Type: 'String' } },
      Resources: {
        R: {
          Type: 'AWS::SNS::Topic',
          // Env is a real reference; ${!Escaped} is a Sub-escaped literal, not a reference.
          Properties: { TopicName: { 'Fn::Sub': 'app-${Env}-${!Escaped}' } },
        },
      },
    };
    const note = unpreviewableParamInfo(template, {}, 'S');
    expect(note).toContain('Env');
    expect(note).not.toContain('Escaped');
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { buildResolverContext } from '../src/desired/template-adapter.js';

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

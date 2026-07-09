import { describe, expect, it } from 'vite-plus/test';
import { contextIgnoredWarning, CONCRETE_REGION } from '../src/synth/synth.js';

describe('CONCRETE_REGION (env.region pin recognition, #742)', () => {
  it('accepts commercial regions', () => {
    for (const r of ['us-east-1', 'eu-west-3', 'ap-southeast-2', 'ca-central-1']) {
      expect(CONCRETE_REGION.test(r)).toBe(true);
    }
  });

  it('accepts GovCloud / ISO multi-infix regions (#742)', () => {
    for (const r of [
      'us-gov-west-1',
      'us-gov-east-1',
      'us-iso-east-1',
      'us-isob-east-1',
      'eu-isoe-west-1',
    ]) {
      expect(CONCRETE_REGION.test(r)).toBe(true);
    }
  });

  it('rejects non-concrete / malformed values (tokens, empty, unresolved)', () => {
    for (const r of [
      '',
      'aws-region',
      '${Token[AWS.Region.123]}',
      'us-east',
      'useast1',
      'US-EAST-1',
    ]) {
      expect(CONCRETE_REGION.test(r)).toBe(false);
    }
  });
});

describe('contextIgnoredWarning (-c/--context dropped for an assembly-dir --app, #956)', () => {
  it('warns (naming the keys) when --app is a pre-synthed dir AND context was passed', () => {
    const msg = contextIgnoredWarning(true, { env: 'prod', foo: 'bar' });
    expect(msg).not.toBeNull();
    expect(msg).toContain('ignoring -c/--context');
    expect(msg).toContain('env');
    expect(msg).toContain('foo');
    expect(msg).toContain('pre-synthesized cloud-assembly');
  });

  it('returns null for a pre-synthed dir when no context was passed', () => {
    expect(contextIgnoredWarning(true, {})).toBeNull();
  });

  it('returns null for a real CDK app command even with context (context IS applied there)', () => {
    expect(contextIgnoredWarning(false, { env: 'prod' })).toBeNull();
  });
});

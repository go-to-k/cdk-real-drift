import { describe, expect, it } from 'vite-plus/test';
import { CONCRETE_REGION } from '../src/synth/synth.js';

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

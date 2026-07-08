import { describe, expect, it } from 'vite-plus/test';
import { CONCRETE_REGION } from '../src/synth/synth.js';

describe('CONCRETE_REGION', () => {
  it('accepts ordinary commercial regions', () => {
    for (const r of ['us-east-1', 'eu-west-3', 'ap-northeast-1', 'ca-central-1']) {
      expect(CONCRETE_REGION.test(r)).toBe(true);
    }
  });

  it('accepts GovCloud / ISO partition regions with multi-part infixes (#742)', () => {
    for (const r of [
      'us-gov-west-1',
      'us-gov-east-1',
      'us-iso-east-1',
      'us-isob-east-1',
      'us-isof-south-1',
      'eu-isoe-west-1',
    ]) {
      expect(CONCRETE_REGION.test(r)).toBe(true);
    }
  });

  it('rejects non-region / unresolved-token strings (env-agnostic stays undefined)', () => {
    for (const s of [
      'unknown-region',
      '${Token[AWS.Region.4]}',
      'us-east',
      'useast1',
      'US-EAST-1',
      '',
      'foobar',
    ]) {
      expect(CONCRETE_REGION.test(s)).toBe(false);
    }
  });
});

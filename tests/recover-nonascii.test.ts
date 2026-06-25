import { describe, expect, it } from 'vite-plus/test';
import { recoverNonAsciiMasks } from '../src/desired/recover-nonascii.js';

describe('recoverNonAsciiMasks (GetTemplate `?`-mask recovery from local synth)', () => {
  it('recovers a masked scalar when the synth value masks to it', () => {
    const deployed = { Resources: { P: { Properties: { Value: '?????ABC' } } } };
    const synth = { Resources: { P: { Properties: { Value: 'áéíóúABC' } } } };
    recoverNonAsciiMasks(deployed, synth);
    expect(deployed.Resources.P.Properties.Value).toBe('áéíóúABC');
  });

  it('does NOT recover when the synth value masks DIFFERENTLY (structural divergence)', () => {
    // synth value has a different length/skeleton → its mask != the deployed mask, so the
    // deployed declared value stays the `?`-mask (and downstream stays a readGap).
    const deployed = { V: '?????ABC' };
    recoverNonAsciiMasks(deployed, { V: 'áéíóúXYZ' }); // mask `?????XYZ` != `?????ABC`
    expect(deployed.V).toBe('?????ABC');
    const deployed2 = { V: '?????ABC' };
    recoverNonAsciiMasks(deployed2, { V: 'áéíóúàABC' }); // 6 non-ASCII → `??????ABC`
    expect(deployed2.V).toBe('?????ABC');
  });

  it('leaves a pure-ASCII template completely untouched (mask never matches)', () => {
    // GetTemplate never masks ASCII, so no deployed leaf is a `?`-mask of a non-ASCII
    // synth value — even a literal `?` in an ASCII value is left as-is.
    const deployed = { A: 'plain', B: 'a?c', N: 5, L: ['x', 'y'] };
    const synth = { A: 'plain', B: 'a?c', N: 5, L: ['x', 'y'] };
    recoverNonAsciiMasks(deployed, synth);
    expect(deployed).toEqual({ A: 'plain', B: 'a?c', N: 5, L: ['x', 'y'] });
  });

  it('walks arrays and nested objects', () => {
    const deployed = { Tags: [{ Value: '???' }, { Value: 'keep' }] };
    const synth = { Tags: [{ Value: 'áéí' }, { Value: 'keep' }] };
    recoverNonAsciiMasks(deployed, synth);
    expect(deployed.Tags[0].Value).toBe('áéí');
    expect(deployed.Tags[1].Value).toBe('keep');
  });

  it('is robust to a missing / mismatched-shape synth side (no throw, no change)', () => {
    const deployed = { V: '?????ABC', Nested: { X: '???' } };
    recoverNonAsciiMasks(deployed, undefined);
    recoverNonAsciiMasks(deployed, { V: 42, Nested: 'not-an-object' });
    expect(deployed).toEqual({ V: '?????ABC', Nested: { X: '???' } });
  });
});

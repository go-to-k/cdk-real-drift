import { describe, expect, it } from 'vite-plus/test';
import { NESTED_OBJECT_ARRAY_IDENTITY, sortNestedObjectArrays } from '../src/normalize/noise.js';

// #1306: sortNestedObjectArrays keys the nested sort on the element IDENTITY (when the type
// declares one via NESTED_OBJECT_ARRAY_IDENTITY) so a NON-identity value change keeps its
// element in the SAME aligned slot on both compare sides — otherwise a plain canonical-JSON
// sort moves the changed element to a new slot and the positional diff cascades into several
// bogus findings.
describe('#1306 sortNestedObjectArrays identity keying', () => {
  const idBy = { FiltersConfig: 'Type' };

  it('sorts a nested object array by its identity field (Type), not full canonical JSON', () => {
    const value = {
      FiltersConfig: [
        { Type: 'SEXUAL', OutputStrength: 'NONE' },
        { Type: 'HATE', OutputStrength: 'HIGH' },
      ],
    };
    const sorted = sortNestedObjectArrays(value, ['FiltersConfig'], idBy) as {
      FiltersConfig: { Type: string }[];
    };
    // ordered by Type: HATE < SEXUAL, independent of the mutable OutputStrength value.
    expect(sorted.FiltersConfig.map((f) => f.Type)).toEqual(['HATE', 'SEXUAL']);
  });

  it('keeps a changed element in the SAME slot as its unchanged twin (no cascade)', () => {
    // Declared vs live differ ONLY in SEXUAL.OutputStrength. An identity-keyed sort puts SEXUAL
    // at the same index on both sides, so a positional diff sees ONE difference — not two.
    const declared = {
      FiltersConfig: [
        { Type: 'HATE', OutputStrength: 'HIGH' },
        { Type: 'SEXUAL', OutputStrength: 'HIGH' },
      ],
    };
    const live = {
      FiltersConfig: [
        { Type: 'SEXUAL', OutputStrength: 'NONE' },
        { Type: 'HATE', OutputStrength: 'HIGH' },
      ],
    };
    const ds = sortNestedObjectArrays(declared, ['FiltersConfig'], idBy) as typeof declared;
    const ls = sortNestedObjectArrays(live, ['FiltersConfig'], idBy) as typeof live;
    // index 0 (HATE) is identical on both sides; only index 1 (SEXUAL) differs.
    expect(ds.FiltersConfig[0]).toEqual(ls.FiltersConfig[0]);
    expect(ds.FiltersConfig[1]!.Type).toBe(ls.FiltersConfig[1]!.Type);
    expect(ds.FiltersConfig[1]!.OutputStrength).not.toBe(ls.FiltersConfig[1]!.OutputStrength);
  });

  it('without an identity field a value change cascades (both slots differ — the bug the table fixes)', () => {
    const declared = {
      FiltersConfig: [
        { Type: 'HATE', OutputStrength: 'LOW' },
        { Type: 'SEXUAL', OutputStrength: 'LOW' },
      ],
    };
    const live = {
      FiltersConfig: [
        { Type: 'SEXUAL', OutputStrength: 'HIGH' },
        { Type: 'HATE', OutputStrength: 'LOW' },
      ],
    };
    // No identity map → canonical-JSON sort. Strengthening SEXUAL to HIGH ("HIGH" < "LOW")
    // moves it BEFORE HATE, so the sorted sides no longer align element-for-element: declared
    // = [HATE(LOW), SEXUAL(LOW)] but live = [SEXUAL(HIGH), HATE(LOW)] — BOTH slots now differ.
    const ds = sortNestedObjectArrays(declared, ['FiltersConfig']) as typeof declared;
    const ls = sortNestedObjectArrays(live, ['FiltersConfig']) as typeof live;
    const misaligned =
      JSON.stringify(ds.FiltersConfig[0]) !== JSON.stringify(ls.FiltersConfig[0]) &&
      JSON.stringify(ds.FiltersConfig[1]) !== JSON.stringify(ls.FiltersConfig[1]);
    expect(misaligned).toBe(true);
  });

  it('the Guardrail identity table names the documented per-array identity fields', () => {
    expect(NESTED_OBJECT_ARRAY_IDENTITY['AWS::Bedrock::Guardrail']).toMatchObject({
      'ContentPolicyConfig.FiltersConfig': 'Type',
      'TopicPolicyConfig.TopicsConfig': 'Name',
      'WordPolicyConfig.WordsConfig': 'Text',
    });
  });
});

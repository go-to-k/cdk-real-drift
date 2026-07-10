// #849 (follow-up) — when an SDK_SUPPLEMENTS read fails, router.ts reports the exempted paths
// (absent from the live model) via ReadResult.readGapPaths -> classifyResource's
// `supplementReadGapPaths`. classify then emits ONE counted `readGap` per path — for a declared
// COLLECTION (not the #752 false `declared` removal), a declared SCALAR, and an UNDECLARED
// exempted prop (gap #2) alike. Without the signal, an absent declared non-empty collection is a
// `declared` removal — so the signal is exactly what prevents the #752 false positive.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

// A neutral resourceType with no READGAP_COLLECTION_PATHS / SCALAR_RETURNED_WHEN_SET entry, so the
// default shape heuristics are unambiguous and the contrast with the supplement signal is clean.
const resource = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType: 'AWS::Test::Thing',
  physicalId: 'r-phys',
  declared,
});

const tierOf = (findings: Finding[], path: string) => findings.find((f) => f.path === path)?.tier;

describe('#849 supplement read-gap classification', () => {
  it('a DECLARED non-empty collection absent from live + in supplementReadGapPaths → readGap (not #752 declared)', () => {
    const declared = { ServiceConnectConfiguration: { Enabled: true, Namespace: 'ns' } };
    const findings = classifyResource(resource(declared), {}, emptySchema, {
      supplementReadGapPaths: ['ServiceConnectConfiguration'],
    });
    expect(tierOf(findings, 'ServiceConnectConfiguration')).toBe('readGap');
    expect(findings.find((f) => f.path === 'ServiceConnectConfiguration')?.note).toContain(
      'supplement read failed'
    );
  });

  it('the SAME collection WITHOUT the signal is a `declared` removal (proves the signal prevents #752)', () => {
    const declared = { ServiceConnectConfiguration: { Enabled: true, Namespace: 'ns' } };
    const findings = classifyResource(resource(declared), {}, emptySchema);
    expect(tierOf(findings, 'ServiceConnectConfiguration')).toBe('declared');
  });

  it('a DECLARED scalar in supplementReadGapPaths → readGap with the supplement note', () => {
    const declared = { AccessString: 'on ~app:* -@all +@read' };
    const findings = classifyResource(resource(declared), {}, emptySchema, {
      supplementReadGapPaths: ['AccessString'],
    });
    expect(tierOf(findings, 'AccessString')).toBe('readGap');
    expect(findings.find((f) => f.path === 'AccessString')?.note).toContain(
      'supplement read failed'
    );
  });

  it('an UNDECLARED exempted prop in supplementReadGapPaths → readGap (gap #2)', () => {
    const findings = classifyResource(
      resource({ UserId: 'reader' }),
      { UserId: 'reader' },
      emptySchema,
      {
        supplementReadGapPaths: ['AccessString'],
      }
    );
    // AccessString is neither declared nor present in live, but the supplement could not read it.
    expect(tierOf(findings, 'AccessString')).toBe('readGap');
  });

  it('a prop the CC read genuinely echoed (present in live) is NOT re-reported as a readGap', () => {
    // Even if listed defensively, a path present in live is readable — no readGap for it.
    const findings = classifyResource(
      resource({ AccessString: 'on ~* +@all' }),
      { AccessString: 'on ~* +@all' },
      emptySchema,
      { supplementReadGapPaths: ['AccessString'] }
    );
    expect(findings.find((f) => f.path === 'AccessString' && f.tier === 'readGap')).toBeUndefined();
  });
});

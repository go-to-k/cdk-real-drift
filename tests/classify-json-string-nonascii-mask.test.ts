// Follow-up to #1247: the JSON_STRING_PROPS whole-unit compare (ConfigRule
// InputParameters) pushed a `declared` finding directly when the structural compare
// failed — bypassing the GetTemplate non-ASCII `?`-mask → readGap demotion the plain
// string-diff path applies (the same bypass the SFN DefinitionString branch had).
// A declared JSON-string / object property whose string leaves carry non-ASCII text
// arrives masked from GetTemplate while the live read is intact, so a clean deploy
// false-flagged as declared drift with a `????…` desired. When the two parsed values
// differ ONLY at masked leaves, demote to readGap; a genuine edit still surfaces.
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

const tierPaths = (fs: Finding[]): string[] => fs.map((f) => `${f.tier}:${f.path}`).sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Rule',
  resourceType: 'AWS::Config::ConfigRule',
  physicalId: 'example-rule',
  declared,
});

// Generic non-ASCII fixture text (NOT copied from any real environment): a label a
// user might legitimately put in a rule parameter, with ASCII interleaved so the
// mask must align around it.
const LIVE_LABEL = 'サンプル説明 tag.<key> を確認';
// Mask exactly as GetTemplate does: every non-ASCII codepoint becomes one `?`.
const MASKED_LABEL = [...LIVE_LABEL]
  .map((ch) => ((ch.codePointAt(0) ?? 0) > 0x7f ? '?' : ch))
  .join('');

describe('JSON_STRING_PROPS GetTemplate non-ASCII mask — readGap, not declared drift', () => {
  it('demotes to readGap when the declared JSON string differs from live ONLY at masked leaves', () => {
    const res = mk({
      InputParameters: `{"label":"${MASKED_LABEL}","maxAge":"90"}`,
    });
    const live = { InputParameters: { label: LIVE_LABEL, maxAge: '90' } };
    const f = classifyResource(res, live, emptySchema);
    // Full tier:path assertion — the demotion must not leave a declared twin behind.
    expect(tierPaths(f)).toEqual(['readGap:InputParameters']);
    expect(f[0].note).toContain('masks non-ASCII');
  });

  it('demotes to readGap for the object-declared form too (CDK object vs live parsed)', () => {
    const res = mk({
      InputParameters: { label: MASKED_LABEL, maxAge: 90 },
    });
    const live = { InputParameters: { label: LIVE_LABEL, maxAge: 90 } };
    const f = classifyResource(res, live, emptySchema);
    expect(tierPaths(f)).toEqual(['readGap:InputParameters']);
  });

  it('still reports declared drift when a genuine change exists alongside the masks', () => {
    const res = mk({
      InputParameters: { label: MASKED_LABEL, maxAge: 90 },
    });
    // Out-of-band: maxAge weakened 90 -> 365 in addition to the masked label.
    const live = { InputParameters: { label: LIVE_LABEL, maxAge: '365' } };
    const f = classifyResource(res, live, emptySchema);
    expect(tierPaths(f)).toEqual(['declared:InputParameters']);
  });

  it('does NOT demote a pure-ASCII change even when the declared value contains a literal "?"', () => {
    const res = mk({ InputParameters: { pattern: 'item.<type>.<size>?' } });
    const live = { InputParameters: { pattern: 'item.<type>.<size>!' } };
    const f = classifyResource(res, live, emptySchema);
    expect(tierPaths(f)).toEqual(['declared:InputParameters']);
  });
});

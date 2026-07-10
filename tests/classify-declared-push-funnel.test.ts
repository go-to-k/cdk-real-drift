// Regression guard for the GetTemplate `?`-mask bypass CLASS (#1247/#1337): the
// mask → readGap demotion lived only on the plain string-diff path, so any special-case
// branch that pushed its `declared` finding directly bypassed it — #712's SFN
// DefinitionString branch reintroduced the false drift that way, and JSON_STRING_PROPS
// repeated it. Two structural defenses, both pinned here:
//   1. Every declared emission flows through the pushDeclaredFinding funnel, which
//      demotes a mask-only difference to readGap centrally.
//   2. A source-level meta-test asserts NO direct `tier: 'declared'` push exists in
//      classify.ts outside the funnel — a future branch that bypasses it fails this
//      test instead of shipping the regression.
import { readFileSync } from 'node:fs';
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

describe('declared-push funnel meta-test (source-level)', () => {
  it("classify.ts contains no direct tier: 'declared' push outside pushDeclaredFinding", () => {
    const src = readFileSync(new URL('../src/diff/classify.ts', import.meta.url), 'utf8');
    expect(src).toContain('function pushDeclaredFinding');
    // Strip line comments so the funnel's own doc comment doesn't count, then require
    // exactly ONE code occurrence — the funnel body. A new special-case branch that
    // pushes `tier: 'declared'` directly (the #712-style bypass) adds a second
    // occurrence and fails here: route it through pushDeclaredFinding instead.
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const occurrences = code.split("tier: 'declared'").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('funnel behavior — a site with no branch-local mask handling is still guarded', () => {
  // ELB attribute bags compare BY KEY and push per-attribute declared findings with no
  // mask logic of their own; the funnel must demote a mask-only Value difference. ELB
  // attribute values are ASCII-constrained in practice — this exercises the FUNNEL,
  // guarding every present and future push site, not an observed ELB false positive.
  const mask = (s: string): string =>
    [...s].map((ch) => ((ch.codePointAt(0) ?? 0) > 0x7f ? '?' : ch)).join('');
  const LIVE_VALUE = 'ラベル tag.<key> 付き';

  const mk = (attrs: unknown): DesiredResource => ({
    logicalId: 'TG',
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/1',
    declared: { TargetGroupAttributes: attrs },
  });

  it('demotes a mask-only attribute Value difference to readGap (carrying the attributeKey)', () => {
    const res = mk([{ Key: 'a.b', Value: mask(LIVE_VALUE) }]);
    const live = { TargetGroupAttributes: [{ Key: 'a.b', Value: LIVE_VALUE }] };
    const f = classifyResource(res, live, emptySchema);
    expect(tierPaths(f).filter((t) => t.startsWith('declared:'))).toEqual([]);
    const gap = f.find((x) => x.tier === 'readGap' && x.path === 'TargetGroupAttributes');
    expect(gap?.note).toContain('masks non-ASCII');
    expect(gap?.attributeKey).toBe('a.b');
  });

  it('still reports a genuine ASCII attribute change as declared drift', () => {
    const res = mk([{ Key: 'a.b', Value: 'true' }]);
    const live = { TargetGroupAttributes: [{ Key: 'a.b', Value: 'false' }] };
    const f = classifyResource(res, live, emptySchema);
    const declared = f.filter((x) => x.tier === 'declared' && x.path === 'TargetGroupAttributes');
    expect(declared).toHaveLength(1);
    expect(declared[0].attributeKey).toBe('a.b');
  });
});

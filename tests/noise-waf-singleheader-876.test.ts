// #876 — a clean WAFv2 WebACL rule that matches on a header (FieldToMatch.SingleHeader)
// produced a DOUBLE false positive on a fresh, un-mutated deploy:
//   1. the template's free-form `FieldToMatch` carries a LOWERCASE `name` key (the
//      documented CDK/CFn form), but the CC read echoes PascalCase `Name` — a case-sensitive
//      diff flags `name` (template-only) + `Name` (live-only) as a `[CFn-Declared Drift]`;
//   2. WAF lowercases the header NAME value (`User-Agent` -> `user-agent`), so the leaf ALSO
//      surfaces as a duplicate `[Potential Drift]` on `SingleHeader.Name`.
// normalizeWafByteMatchDeep now canonicalizes the SingleHeader / SingleQueryArgument selector
// on BOTH compare sides ({ name|Name } -> { Name: <lowercased> }), folding both findings while
// still surfacing a genuine header-name change.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { normalizeWafByteMatchDeep } from '../src/normalize/noise.js';
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

function tiers(findings: Finding[]) {
  const by = (t: string) =>
    findings
      .filter((f) => f.tier === t)
      .map((f) => f.path)
      .sort();
  return { declared: by('declared'), undeclared: by('undeclared') };
}

// Build a WebACL Rules array with a single ByteMatchStatement matching on a SingleHeader.
// `wrap` optionally nests the statement inside an And/Or/Not composite (recursion coverage).
function webAcl(
  headerKey: 'name' | 'Name',
  headerValue: string,
  wrap: 'none' | 'and' | 'or' = 'none'
): Record<string, unknown> {
  const byteMatch = {
    ByteMatchStatement: {
      SearchString: 'evil',
      FieldToMatch: { SingleHeader: { [headerKey]: headerValue } },
      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
      PositionalConstraint: 'CONTAINS',
    },
  };
  let statement: Record<string, unknown> = byteMatch;
  if (wrap === 'and') statement = { AndStatement: { Statements: [byteMatch] } };
  else if (wrap === 'or') statement = { OrStatement: { Statements: [byteMatch] } };
  return {
    Rules: [
      {
        Name: 'ua-block',
        Priority: 0,
        Action: { Block: {} },
        Statement: statement,
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: 'ua',
        },
      },
    ],
  };
}

function webAclResource(acl: Record<string, unknown>): DesiredResource {
  return {
    logicalId: 'Acl',
    resourceType: 'AWS::WAFv2::WebACL',
    physicalId: 'acl-phys',
    declared: acl,
  };
}

describe('WAFv2 FieldToMatch.SingleHeader key+value canonicalization (#876)', () => {
  it('declared { name: "User-Agent" } vs live { Name: "user-agent" } → NO drift', () => {
    // Exact live-vs-declared shape from the issue: template lowercase `name`/mixed-case value,
    // live PascalCase `Name`/lowercased value. Neither the declared FP nor the duplicate
    // potential-drift may surface.
    const declared = webAcl('name', 'User-Agent');
    const live = webAcl('Name', 'user-agent');
    const t = tiers(classifyResource(webAclResource(declared), live, emptySchema));
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual([]);
  });

  it('a GENUINE header-name change (declared user-agent vs live referer) still surfaces', () => {
    const declared = webAcl('name', 'User-Agent');
    const live = webAcl('Name', 'referer');
    const findings = classifyResource(webAclResource(declared), live, emptySchema);
    // A real divergence must still be caught — the fold is equality-gated by the lowercased value.
    const t = tiers(findings);
    expect(t.declared.length + t.undeclared.length).toBeGreaterThan(0);
  });

  it('SingleHeader nested inside an AndStatement folds (recursion)', () => {
    const declared = webAcl('name', 'User-Agent', 'and');
    const live = webAcl('Name', 'user-agent', 'and');
    const t = tiers(classifyResource(webAclResource(declared), live, emptySchema));
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual([]);
  });

  it('SingleHeader nested inside an OrStatement folds (recursion)', () => {
    const declared = webAcl('name', 'X-Custom', 'or');
    const live = webAcl('Name', 'x-custom', 'or');
    const t = tiers(classifyResource(webAclResource(declared), live, emptySchema));
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual([]);
  });

  it('AWS::WAFv2::RuleGroup routes through the same SingleHeader canonicalization', () => {
    // A RuleGroup carries the identical Rules/Statement shape and the same case divergence;
    // the pipeline gate now folds it too (issue fix-shape explicitly lists RuleGroup).
    const declared = webAcl('name', 'User-Agent');
    const live = webAcl('Name', 'user-agent');
    const ruleGroupResource: DesiredResource = {
      logicalId: 'Rg',
      resourceType: 'AWS::WAFv2::RuleGroup',
      physicalId: 'rg-phys',
      declared,
    };
    const t = tiers(classifyResource(ruleGroupResource, live, emptySchema));
    expect(t.declared).toEqual([]);
    expect(t.undeclared).toEqual([]);
  });

  it('SingleQueryArgument selector is canonicalized the same way', () => {
    const declared = { FieldToMatch: { SingleQueryArgument: { name: 'MyArg' } } };
    const live = { FieldToMatch: { SingleQueryArgument: { Name: 'myarg' } } };
    expect(normalizeWafByteMatchDeep(declared)).toEqual(normalizeWafByteMatchDeep(live));
  });

  it('normalizeWafByteMatchDeep folds { name } and { Name } to one { Name: lowercased } form', () => {
    const declared = { FieldToMatch: { SingleHeader: { name: 'User-Agent' } } };
    const live = { FieldToMatch: { SingleHeader: { Name: 'user-agent' } } };
    const canonical = { FieldToMatch: { SingleHeader: { Name: 'user-agent' } } };
    expect(normalizeWafByteMatchDeep(declared)).toEqual(canonical);
    expect(normalizeWafByteMatchDeep(live)).toEqual(canonical);
  });

  it('genuine header-name difference is NOT folded by the deep normalizer', () => {
    const a = { SingleHeader: { name: 'User-Agent' } };
    const b = { SingleHeader: { Name: 'referer' } };
    expect(normalizeWafByteMatchDeep(a)).not.toEqual(normalizeWafByteMatchDeep(b));
  });

  it('a non-string / extra-key SingleHeader shape is preserved (no silent drop)', () => {
    const weird = { SingleHeader: { Name: 123, Extra: 'keep' } };
    expect(normalizeWafByteMatchDeep(weird)).toEqual({
      SingleHeader: { Name: 123, Extra: 'keep' },
    });
  });
});

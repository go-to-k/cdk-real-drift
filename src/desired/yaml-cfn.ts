// CloudFormation-aware YAML parser (parse-only). Copied/trimmed from cdkd
// src/cli/yaml-cfn.ts — preserves CFn shorthand tags (!Ref/!GetAtt/!Sub/...) by
// resolving each to its long-form object ({Ref:...} / {Fn::Foo:...}) so the rest
// of cdk-real-drift reads one canonical (JSON-equivalent) representation.

import type { CollectionTag, ScalarTag, YAMLMap, YAMLSeq } from 'yaml';
import { parse as yamlParse } from 'yaml';

export type TemplateFormat = 'json' | 'yaml';

const FN_TAGS = [
  'GetAtt',
  'Sub',
  'Join',
  'Select',
  'Split',
  'If',
  'Equals',
  'And',
  'Or',
  'Not',
  'FindInMap',
  'Base64',
  'Cidr',
  'GetAZs',
  'ImportValue',
  'Length',
  'ToJsonString',
  'ForEach',
] as const;

function nodeJs(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node === 'object' && 'toJSON' in (node as object))
    return (node as { toJSON(): unknown }).toJSON();
  return node;
}

function buildCustomTags(): Array<ScalarTag | CollectionTag> {
  const tags: Array<ScalarTag | CollectionTag> = [];
  tags.push({
    tag: '!Ref',
    resolve: (v: string) => ({ Ref: v }),
    identify: () => false,
  } as ScalarTag);
  tags.push({
    tag: '!Condition',
    resolve: (v: string) => ({ Condition: v }),
    identify: () => false,
  } as ScalarTag);
  tags.push({
    tag: '!Transform',
    collection: 'map',
    resolve: (n: YAMLMap) => ({ 'Fn::Transform': nodeJs(n) }),
    identify: () => false,
  } as CollectionTag);
  tags.push({
    tag: '!GetAtt',
    resolve(value: string): unknown {
      const dot = value.indexOf('.');
      // A dot-less `!GetAtt X` is malformed (CFn wants `<LogicalId>.<Attribute>`),
      // but a custom-tag `resolve` that THROWS aborts the whole `yaml` parse — one
      // bad scalar would crash the entire stack check (GetTemplate returns the
      // deployed body verbatim, and a --pre-deploy synth / hand-written template can
      // carry it). Degrade to a 1-element Fn::GetAtt instead: resolveGetAtt requires
      // length >= 2, so it resolves to UNRESOLVED and that one property is skipped,
      // never mis-compared — the rest of the template still parses.
      if (dot < 0) return { 'Fn::GetAtt': [value] };
      return { 'Fn::GetAtt': [value.slice(0, dot), value.slice(dot + 1)] };
    },
    identify: () => false,
  } as ScalarTag);
  tags.push({
    tag: '!GetAtt',
    collection: 'seq',
    resolve: (n: YAMLSeq) => ({ 'Fn::GetAtt': nodeJs(n) }),
    identify: () => false,
  } as CollectionTag);
  for (const name of FN_TAGS) {
    if (name === 'GetAtt') continue;
    const longKey = `Fn::${name}`;
    tags.push({
      tag: `!${name}`,
      resolve: (v: string | number | null) => ({ [longKey]: v }),
      identify: () => false,
    } as ScalarTag);
    tags.push({
      tag: `!${name}`,
      collection: 'seq',
      resolve: (n: YAMLSeq) => ({ [longKey]: nodeJs(n) }),
      identify: () => false,
    } as CollectionTag);
    tags.push({
      tag: `!${name}`,
      collection: 'map',
      resolve: (n: YAMLMap) => ({ [longKey]: nodeJs(n) }),
      identify: () => false,
    } as CollectionTag);
  }
  return tags;
}

const CUSTOM_TAGS = buildCustomTags();

export function detectTemplateFormat(text: string): TemplateFormat {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = stripped.trimStart();
  if (trimmed.length === 0) return 'json';
  const first = trimmed.charCodeAt(0);
  return first === 0x7b || first === 0x5b ? 'json' : 'yaml'; // '{' or '['
}

export function parseCfnTemplate(text: string): Record<string, unknown> {
  const format = detectTemplateFormat(text);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  if (format === 'json') {
    parsed = JSON.parse(body);
  } else {
    // CloudFormation's service-side YAML parser resolves the YAML 1.1 schema, not
    // yaml@2's default 1.2 core schema. Under 1.2 `yes`/`no`/`on`/`off` stay strings
    // and `0755` parses as decimal 755 — diverging from what CFn actually deployed
    // (1.1 folds those to boolean / octal 493, and `1:30` to sexagesimal 90),
    // producing first-run declared false positives and silent revert corruption
    // (#785). Pinning `version: '1.1'` selects the `yaml-1.1` base schema so implicit
    // scalar resolution matches CFn. CUSTOM_TAGS (the CFn short forms) still layer on
    // top as additional tags; the YAML-1.1-only `!!binary`/`!!timestamp`/... tags only
    // fire on explicit `!!` markers a CFn template never carries, so no regression.
    parsed = yamlParse(body, { version: '1.1', customTags: CUSTOM_TAGS });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Template root is not an object.');
  }
  return parsed as Record<string, unknown>;
}

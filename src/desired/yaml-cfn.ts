// CloudFormation-aware YAML parser (parse-only). Copied/trimmed from cdkd
// src/cli/yaml-cfn.ts — preserves CFn shorthand tags (!Ref/!GetAtt/!Sub/...) by
// resolving each to its long-form object ({Ref:...} / {Fn::Foo:...}) so the rest
// of cdk-real-drift reads one canonical (JSON-equivalent) representation.

import type {
  CollectionTag,
  ParseOptions,
  ScalarTag,
  SchemaOptions,
  Tags,
  YAMLMap,
  YAMLSeq,
} from 'yaml';
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

// The stock `yaml@2` YAML-1.1 schema over-resolves two plain-scalar shapes that
// CloudFormation itself does NOT resolve (CFn deploys both as strings), producing
// declared-tier false positives that survive `record` and corrupt `revert` (#850):
//   1. Implicit timestamps — an unquoted `2026-01-01` / `2010-09-09` /
//      `2001-12-14 21:59:43.10 -5` resolves to a JS `Date` OBJECT via the
//      `tag:yaml.org,2002:timestamp` tag.
//   2. Single-letter booleans — the 1.1 `bool` test regexes include `Y|y` and
//      `N|n`, so `N` -> `false` and `Y` -> `true` (an AttributeType, a flag, ...).
// These regexes exclude the single-letter `Y/y/N/n` forms while KEEPING the
// `yes/no/on/off/true/false` forms — matching CFn and preserving the #785 fix.
const TRUE_BOOL_TEST = /^(?:[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/;
const FALSE_BOOL_TEST = /^(?:[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/;
const BOOL_TAG = 'tag:yaml.org,2002:bool';
// The `Date`-producing tag. The sexagesimal `intTime`/`floatTime` tags share the
// int/float tag URIs (they yield NUMBERS like `1:30` -> 90, which #785 needs), so
// only THIS tag URI is neutralized — the sexagesimal number resolution is preserved.
const TIMESTAMP_TAG = 'tag:yaml.org,2002:timestamp';

// Take the resolved YAML-1.1 core tags and (a) neutralize the `timestamp` tag so a
// date-like scalar stays a string, and (b) swap the two `bool` tags for copies whose
// `test` excludes single-letter `Y/y/N/n`. The CFn short-form tags (`!Ref`/`!GetAtt`/...)
// are appended so they still layer on top.
function restrictYaml11Tags(baseTags: Tags): Tags {
  const restricted: Tags = [];
  for (const tag of baseTags) {
    // A resolved schema's tags are objects, but the `Tags` element type also admits
    // `TagId` string aliases — leave any such entry untouched (it is not a bool/timestamp).
    if (typeof tag === 'string') {
      restricted.push(tag);
      continue;
    }
    if (tag.tag === TIMESTAMP_TAG) {
      // #860 merely DROPPED this tag so a date-like PLAIN scalar stays a string. But
      // omitting the tag leaves yaml@2's `knownTags` fallback intact, so the EXPLICIT
      // form `!!timestamp 2026-01-01` still resolved through the base schema's tag to a
      // JS `Date` — a declared-tier false positive that survives `record` and corrupts
      // `revert` (#909). Instead of dropping the tag, KEEP it but override `resolve` to
      // return the raw source string. That kills the `Date` for BOTH the implicit and
      // the explicit form, so a date-like scalar (however tagged) stays the string
      // CloudFormation deployed. Rebuild it as an explicit ScalarTag (a spread of the
      // tag union widens the shape and loses the ScalarTag discriminant).
      const scalar = tag as ScalarTag;
      restricted.push({
        ...scalar,
        resolve: (value: string) => value,
      } as ScalarTag);
      continue;
    }
    if (tag.tag === BOOL_TAG) {
      // The 1.1 schema carries a separate tag for `true` and for `false`; each
      // `identify`s only its own boolean. Use that to pick the matching narrowed
      // `test`, so the swap is robust regardless of the tag array's order. Rebuild it
      // as an explicit ScalarTag (a spread of the tag union widens `test` and loses
      // the ScalarTag discriminant).
      const scalar = tag as ScalarTag;
      const isTrueTag = scalar.identify?.(true) === true;
      restricted.push({
        ...scalar,
        test: isTrueTag ? TRUE_BOOL_TEST : FALSE_BOOL_TEST,
      } as ScalarTag);
      continue;
    }
    restricted.push(tag);
  }
  return restricted.concat(CUSTOM_TAGS as Tags);
}

const CFN_YAML_PARSE_OPTIONS: ParseOptions & SchemaOptions = {
  schema: 'yaml-1.1',
  customTags: restrictYaml11Tags,
};

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
    // (#785). But the STOCK 1.1 schema also over-resolves plain date-like scalars to
    // `Date` and single-letter `Y/N` to boolean, which CFn does NOT do (#850) — so we
    // use a RESTRICTED yaml-1.1 schema (`restrictYaml11Tags`): 1.1 semantics minus
    // timestamps (implicit AND explicit) minus single-letter bools, composed with the CFn short
    // forms. The YAML-1.1 `!!binary`/... tags only fire on explicit `!!` markers a
    // CFn template never carries, so no regression.
    parsed = yamlParse(body, CFN_YAML_PARSE_OPTIONS);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Template root is not an object.');
  }
  return parsed as Record<string, unknown>;
}

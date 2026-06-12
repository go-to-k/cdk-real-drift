// Generative INVARIANT tests (R73): instead of hand-picking inputs, generate
// hundreds of pseudo-random property models (seeded LCG — fully deterministic,
// no Math.random) and assert properties that must hold for EVERY input. These
// catch whole CLASSES of bugs the example-based tests can't enumerate:
//   1. self-compare is CLEAN     — classify(declared=X, live=X) yields nothing
//   2. accept-all suppresses all — applyBaseline after a full accept leaves no
//                                  undeclared survivors (and no removals)
//   3. canonicalization is IDEMPOTENT and never throws on weird shapes
//   4. the strips never throw and never INVENT keys
//   5. sanitizeAccountId is idempotent and shape-preserving
import { describe, expect, it } from 'vite-plus/test';
import { applyBaseline, buildAccepted } from '../src/baseline/baseline-file.js';
import { sanitizeAccountId } from '../src/corpus/record.js';
import { classifyResource } from '../src/diff/classify.js';
import { deepEqual } from '../src/diff/drift-calculator.js';
import { stripCcApiAwsManagedFields } from '../src/normalize/cc-api-strip.js';
import { stripAwsTagsDeep } from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import type { Finding, SchemaInfo } from '../src/types.js';

// ---- deterministic pseudo-random model generator (seeded LCG) ----

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  'Status',
  'Enabled',
  'Name',
  'Arn',
  'Tags',
  'Policy',
  'Config',
  'Rules',
  'Key',
  'Value',
  'Action',
  'Statement',
  'Type',
  'Size',
  'Mode',
  'Port',
  'aws:SecureTransport',
  'Condition',
  'Principal',
  'Resource',
  'Id',
];

function genValue(rnd: () => number, depth: number): unknown {
  const r = rnd();
  if (depth <= 0 || r < 0.35) {
    // scalar
    const k = rnd();
    if (k < 0.25) return Math.floor(rnd() * 1000);
    if (k < 0.45) return rnd() < 0.5;
    if (k < 0.55) return '';
    if (k < 0.7) return `arn:aws:s3:::bucket-${Math.floor(rnd() * 99)}`;
    return WORDS[Math.floor(rnd() * WORDS.length)];
  }
  if (r < 0.6) {
    // array (may be heterogeneous, nested, or empty)
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => genValue(rnd, depth - 1));
  }
  // object
  const n = 1 + Math.floor(rnd() * 4);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    out[WORDS[Math.floor(rnd() * WORDS.length)]!] = genValue(rnd, depth - 1);
  }
  return out;
}

function genModel(seed: number): Record<string, unknown> {
  const rnd = lcg(seed);
  const n = 1 + Math.floor(rnd() * 6);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    out[`P${i}_${WORDS[Math.floor(rnd() * WORDS.length)]}`] = genValue(rnd, 4);
  }
  return out;
}

const EMPTY_SCHEMA: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
};

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('generative invariants (R73)', () => {
  it('1. self-compare is CLEAN: classify(template-form X, aws-augmented X) yields no findings', () => {
    // The realizable input space: a template can never declare aws:* TAG
    // entries (CFn rejects the reserved prefix), but the LIVE model carries
    // them — so declared = stripAwsTagsDeep(X) and live = X must compare
    // CLEAN for every X. aws:* keys NOT under a Tags key (IAM condition keys)
    // appear identically on BOTH sides and must also be clean — this exact
    // property would have caught the R69 condition-key-stripping bug.
    for (const seed of SEEDS) {
      const model = genModel(seed);
      const findings = classifyResource(
        {
          logicalId: 'L',
          resourceType: 'AWS::X::Y',
          physicalId: 'phys',
          declared: stripAwsTagsDeep(structuredClone(model)) as Record<string, unknown>,
        },
        structuredClone(model),
        EMPTY_SCHEMA,
        { accountId: '111111111111', region: 'us-east-1', kmsAliasTargets: {} }
      );
      expect(findings, `seed ${seed}`).toEqual([]);
    }
  });

  it('2. accept-all suppresses ALL undeclared findings (and synthesizes no removals)', () => {
    for (const seed of SEEDS) {
      const model = genModel(seed);
      // every top-level key as an undeclared finding, values canonicalized the
      // way classify produces them (actual is post-pipeline canonical)
      const findings: Finding[] = Object.entries(model).map(([path, v]) => {
        // canonicalize the way classify does (actual is post-pipeline canonical)
        const canonical = canonicalizeForCompare(
          stripAwsTagsDeep(stripCcApiAwsManagedFields({ [path]: v }))
        ) as Record<string, unknown>;
        return {
          tier: 'undeclared' as const,
          logicalId: 'L',
          resourceType: 'AWS::X::Y',
          path,
          actual: canonical[path],
        };
      });
      const baseline = {
        schemaVersion: 2 as const,
        stackName: 's',
        region: 'r',
        accountId: 'a',
        capturedAt: '',
        templateHash: '',
        accepted: buildAccepted(findings),
        completeResources: ['L'],
      };
      const out = applyBaseline(structuredClone(findings), baseline);
      expect(out, `seed ${seed}`).toEqual([]);
    }
  });

  it('3. canonicalizeForCompare is idempotent and total (never throws)', () => {
    for (const seed of SEEDS) {
      const model = genModel(seed);
      const once = canonicalizeForCompare(structuredClone(model));
      const twice = canonicalizeForCompare(structuredClone(once));
      expect(deepEqual(once, twice), `seed ${seed}: canon(canon(x)) != canon(x)`).toBe(true);
    }
    // hostile shapes
    for (const v of [null, undefined, 0, '', false, [], {}, [[]], [null], { a: undefined }]) {
      expect(() => canonicalizeForCompare(v)).not.toThrow();
    }
  });

  it('4. strips are total and never INVENT keys', () => {
    for (const seed of SEEDS) {
      const model = genModel(seed);
      const stripped = stripAwsTagsDeep(
        stripCcApiAwsManagedFields(structuredClone(model))
      ) as Record<string, unknown>;
      for (const k of Object.keys(stripped)) {
        expect(k in model, `seed ${seed}: invented key ${k}`).toBe(true);
      }
    }
    for (const v of [null, undefined, 0, '', false, [], [[]], [null]]) {
      expect(() => stripAwsTagsDeep(v)).not.toThrow();
    }
  });

  it('5. sanitizeAccountId is idempotent and shape-preserving', () => {
    for (const seed of SEEDS) {
      const model = genModel(seed);
      const withAcct = { ...model, Arn: `arn:aws:iam::123456789012:role/x-${seed}` };
      const once = sanitizeAccountId(structuredClone(withAcct), '123456789012');
      const twice = sanitizeAccountId(structuredClone(once), '123456789012');
      expect(deepEqual(once, twice), `seed ${seed}`).toBe(true);
      expect(JSON.stringify(once)).not.toContain('123456789012');
      expect(Object.keys(once as object).sort()).toEqual(Object.keys(withAcct).sort());
    }
  });
});

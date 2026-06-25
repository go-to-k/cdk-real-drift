// First-run-noise measurement (the KNOWN_DEFAULTS-candidate finder).
//
// schema `default` annotations cover only ~1% of properties (see
// scripts/measure-schema-defaults.mjs and docs/ARCHITECTURE.md § 6), so the
// `undeclared` values that surface as [Potential Drift] on a first run are folded
// to `atDefault` almost entirely by the HAND-maintained KNOWN_DEFAULTS /
// KNOWN_DEFAULT_PATHS tables. This replays the real classify pipeline over the
// golden corpus (the same inputs corpus-replay.test.ts asserts on) and buckets
// every `undeclared` finding by (resourceType, path), so recurring constant-
// looking values can be promoted into those tables — shrinking first-run noise.
// The fold is equality-gated, so a promoted default can never hide a real change.
//
// This is the OFFLINE half of the loop: it mines whatever corpus exists today.
// The /hunt-bugs skill is the data-gathering half — it deploys uncovered common
// types (recording new corpus via CDKRD_CORPUS_DIR), then runs this to propose
// KNOWN_DEFAULTS candidates.
//
// Run the full report (it is silent in the normal unit suite):
//   CDKRD_MEASURE_NOISE=1 vp test run tests/measure-noise.test.ts
//   # or the wrapper: bash scripts/measure-noise.sh
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { type CorpusCase, decodeUnresolved, reviveSchema } from '../src/corpus/record.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource } from '../src/types.js';

// Advisory triage of an undeclared value: is it a CONSTANT-looking service default
// (a KNOWN_DEFAULTS candidate) or resource-specific INVENTORY (an id/ARN/name that
// must stay undeclared → baseline)? `review` = a structure to eyeball by hand.
// Pure + exercised below so the heuristic is regression-guarded. Conservative: when
// unsure it does NOT say `candidate`, so nothing FP-prone is auto-suggested.
export type Triage = 'candidate' | 'inventory' | 'review';
export function triageValue(value: unknown, physicalId: string | undefined): Triage {
  if (typeof value === 'boolean' || typeof value === 'number') return 'candidate';
  if (typeof value === 'string') {
    if (value.length === 0) return 'inventory'; // empty is dropped upstream anyway
    if (value.startsWith('arn:')) return 'inventory';
    if (physicalId && value.includes(physicalId)) return 'inventory';
    if (/^\d{12}$/.test(value)) return 'inventory'; // account id
    // an id/hash-looking token (uuid, generated suffix, long hex) → resource-specific
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(value) || /-[0-9a-z]{8,}$/i.test(value)) return 'inventory';
    return 'candidate'; // short enum-like string (e.g. "ACTIVE", "GP2")
  }
  return 'review'; // object / array — a nested default block to inspect by hand
}

interface Bucket {
  resourceType: string;
  path: string;
  nested: boolean;
  count: number;
  example: unknown;
  triage: Triage;
}

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

function mineUndeclared(): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const file of readdirSync(corpusDir).filter((f) => f.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusCase;
    if (c.corpusVersion !== 1) continue;
    const resource = {
      ...c.resource,
      declared: decodeUnresolved(c.resource.declared),
    } as DesiredResource;
    let findings;
    try {
      findings = classifyResource(
        resource,
        structuredClone(c.liveRaw),
        reviveSchema(c.schema),
        c.opts
      );
    } catch {
      continue; // a malformed case never blocks the sweep
    }
    for (const f of findings) {
      if (f.tier !== 'undeclared') continue;
      const key = `${f.resourceType}\t${f.path}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        continue;
      }
      byKey.set(key, {
        resourceType: f.resourceType,
        path: f.path,
        nested: f.nested === true,
        count: 1,
        example: f.actual,
        triage: triageValue(f.actual, c.resource.physicalId),
      });
    }
  }
  // candidates first, then by frequency — the highest-value promotions on top
  const rank = (t: Triage): number => (t === 'candidate' ? 0 : t === 'review' ? 1 : 2);
  return [...byKey.values()].sort(
    (a, b) => rank(a.triage) - rank(b.triage) || b.count - a.count || (a.path < b.path ? -1 : 1)
  );
}

function formatReport(buckets: Bucket[]): string {
  const line = (b: Bucket): string =>
    `  ${b.triage.toUpperCase().padEnd(9)} x${b.count}  ${b.resourceType}  ${b.path}` +
    `${b.nested ? ' (nested → KNOWN_DEFAULT_PATHS)' : ' (top → KNOWN_DEFAULTS)'}` +
    `  e.g. ${JSON.stringify(b.example)?.slice(0, 80)}`;
  const cands = buckets.filter((b) => b.triage === 'candidate');
  const review = buckets.filter((b) => b.triage === 'review');
  return [
    `first-run-noise sweep: ${buckets.length} distinct undeclared (type, path) across the corpus`,
    `  CANDIDATE (constant-looking → promote to a *_DEFAULTS table): ${cands.length}`,
    `  REVIEW (nested structures to inspect): ${review.length}`,
    `  INVENTORY (resource-specific, leave undeclared): ${buckets.length - cands.length - review.length}`,
    '',
    ...buckets.map(line),
  ].join('\n');
}

describe('first-run-noise measurement', () => {
  it('triageValue: constants are candidates, ids/ARNs are inventory, structures are review', () => {
    expect(triageValue(false, 'p')).toBe('candidate');
    expect(triageValue(30, 'p')).toBe('candidate');
    expect(triageValue('GP2', 'p')).toBe('candidate');
    expect(triageValue('arn:aws:iam::1:role/x', 'p')).toBe('inventory');
    expect(triageValue('my-bucket-name', 'my-bucket-name')).toBe('inventory');
    expect(triageValue('123456789012', 'p')).toBe('inventory');
    expect(triageValue('a1b2c3d4-e5f6-7890-ab12-cd34ef56', 'p')).toBe('inventory');
    expect(triageValue({ Foo: 1 }, 'p')).toBe('review');
  });

  it('mines the corpus and writes the candidate report (only under CDKRD_MEASURE_NOISE)', () => {
    const buckets = mineUndeclared();
    expect(Array.isArray(buckets)).toBe(true);
    // `vp test run` intercepts console output, so write the report to a file the
    // wrapper (scripts/measure-noise.sh) then prints, rather than console.log.
    if (process.env.CDKRD_MEASURE_NOISE) {
      const out = process.env.CDKRD_NOISE_OUT ?? join(tmpdir(), 'cdkrd-noise-report.txt');
      writeFileSync(out, `${formatReport(buckets)}\n`);
    }
  });
});

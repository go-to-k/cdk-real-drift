import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Guard against a report-label rename silently breaking the integration fixtures.
//
// The `tests/integration/**/*.sh` live-assertion scripts `grep -q "<label>"` the
// user-facing report SECTION labels (e.g. "At AWS Default", "CFn-Declared Drift").
// Those scripts are EXCLUDED from `vp test run`, so a label rename that updates
// report.ts (+ its unit tests) but forgets the shell greps sails through unit-green
// and only surfaces as a live-integ FALSE failure — a stale `grep -q "AT AWS DEFAULT"`
// against the current "At AWS Default" section (the exact miss the #468 PR fixed; the
// wider recurring class is [[report-label-rename-sweep]]).
//
// SCOPE (deliberately narrow, zero false positives): this catches a CASE / spacing
// drift of a WHOLE section label under a case-SENSITIVE `grep -q` — a grep whose
// letters match a current label but whose exact text does not. It does NOT (and
// cannot, without an old→new map) catch a full WORDING rename, where the stale grep
// shares no letters with the new label; that class stays covered by running the integ
// suite before release + the sweep memory. All-lowercase greps are exempt: the report
// prints BOTH a Title-Case section header ("Skipped") AND lowercase info lines
// ("skipped=N" / "deleted — …"), so a lowercase grep is a legit distinct string, not a
// stale form of the Title-Case label.
const url = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// Canonical section labels, parsed from report.ts so this stays in sync automatically.
function canonicalLabels(): string[] {
  const src = readFileSync(url('../src/report/report.ts'), 'utf8');
  const block = src.slice(
    src.indexOf('const TIER_NAMES'),
    src.indexOf('};', src.indexOf('const TIER_NAMES'))
  );
  const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  // The not-in-baseline inventory renders under the literal "Potential Drift" section
  // (not a Tier in TIER_NAMES); integ scripts assert it too.
  return [...new Set([...names, 'Potential Drift'])];
}

// Every `.sh` under tests/integration, recursively.
function shellScripts(): string[] {
  const root = url('../tests/integration');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sh')) out.push(p);
    }
  };
  walk(root);
  return out;
}

const nkey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const isAllLower = (s: string): boolean => s === s.toLowerCase();
// Case-SENSITIVE `grep -q` with a static literal (no `$`, single or double quoted).
// `grep -qi` (case-insensitive) is skipped — casing cannot drift there.
const GREP_Q = /grep\s+-q([a-hj-zA-HJ-Z]*)\s+(["'])((?:(?!\2).)*)\2/g;

describe('integration-script report-label greps stay in sync with report.ts (casing guard)', () => {
  const labels = canonicalLabels();
  const keys = new Map(labels.map((l) => [nkey(l), l]));

  it('report.ts exposes the section labels this guard parses', () => {
    expect(labels).toContain('At AWS Default');
    expect(labels).toContain('CFn-Declared Drift');
    expect(labels).toContain('Potential Drift');
  });

  for (const file of shellScripts()) {
    const rel = file.slice(file.indexOf('tests/integration'));
    it(`${rel}: no stale-cased report-label grep`, () => {
      const src = readFileSync(file, 'utf8');
      const stale: string[] = [];
      for (const m of src.matchAll(GREP_Q)) {
        const literal = m[3]!;
        if (literal.includes('$')) continue; // interpolated — not a static label
        const label = keys.get(nkey(literal));
        // Same letters as a Title-Case section label but NOT containing that label as an
        // exact substring (so the difference is casing/spacing, not just bracket/colon
        // decoration like `\[At AWS Default:`), and not a legit all-lowercase info-line
        // string ("skipped=" / "deleted — …") → a stale-cased grep.
        if (label && !literal.includes(label) && !isAllLower(literal)) {
          stale.push(`grep -q "${literal}" should contain "${label}"`);
        }
      }
      expect(stale, `${rel} greps a stale-cased report label:\n  ${stale.join('\n  ')}`).toEqual(
        []
      );
    });
  }
});

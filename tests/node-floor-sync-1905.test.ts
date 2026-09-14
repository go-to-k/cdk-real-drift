import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Node.js floor sync fence (go-to-k/cdk-real-drift#1905).
 *
 * The published runtime floor is stated in FOUR places that nothing ties
 * together: `package.json`'s `engines.node` (what npm warns on), the `pack`
 * target in `vite.config.ts` (what syntax tsdown may emit), the
 * `runtime-compat` matrix in `.github/workflows/ci.yml` (the only surface that
 * EXECUTES the bundle on the floor), and the prose in README / CONTRIBUTING.
 * Each drifted per-surface in the sibling repos — go-to-k/cdkd#3037 and
 * go-to-k/cdk-local#722 raised the same floor and found the surfaces
 * disagreeing — so this fence pins every surface to ONE literal.
 *
 * `FLOOR` is a literal, never derived from package.json: a fence that reads
 * its expected value from one of the surfaces it checks cannot see that
 * surface move. Everything else here is DERIVED from it — the docs spelling,
 * the matrix's first row, the retired spellings the prose must not carry —
 * so the next bump edits this one constant plus every surface, and a docs
 * file that keeps BOTH the old and the new floor goes red on the old one.
 */

const FLOOR = '22.12.0';
const [FLOOR_MAJOR_STR, FLOOR_MINOR_STR] = FLOOR.split('.');
const FLOOR_MAJOR = Number(FLOOR_MAJOR_STR);
/**
 * The `major.minor` spelling the docs and the matrix's floor row use — the
 * bare major when the floor is an `.0` minor ("Node.js 24", not "24.0").
 */
const FLOOR_SHORT =
  FLOOR_MINOR_STR === '0' ? FLOOR_MAJOR_STR : `${FLOOR_MAJOR_STR}.${FLOOR_MINOR_STR}`;
/**
 * Spellings that advertised an OLDER floor, generated for every major below
 * the current one back to the oldest this package ever shipped on. Kept
 * specific to a FLOOR statement ("or later", ">=") so an EOL note such as
 * "Node 20 is past end of life" stays legal.
 */
const OLDEST_EVER_SHIPPED_MAJOR = 18;
const OLD_FLOOR_SPELLINGS = Array.from(
  { length: FLOOR_MAJOR - OLDEST_EVER_SHIPPED_MAJOR },
  (_, i) => OLDEST_EVER_SHIPPED_MAJOR + i
).flatMap((m) => [
  `Node.js ${m} or later`,
  `Node.js ${m} or higher`,
  `Node.js ${m} or newer`,
  `Node.js ${m}+`,
  `Node ${m} or later`,
  `Node ${m} or higher`,
  `Node ${m} or newer`,
  `Node ${m}+`,
  `v${m}.x`,
  `>=${m}`,
  `>= ${m}`,
]);

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

// Every read below spells its target as literal `join(REPO_ROOT, ...)` segments
// so tests/check-scope-checker-inputs-1837.test.ts can see it as a checker input.
describe('the published Node.js floor is one value across every surface (#1905)', () => {
  it('the derived spellings are non-vacuous', () => {
    expect(Number.isInteger(FLOOR_MAJOR)).toBe(true);
    expect(FLOOR_MAJOR).toBeGreaterThan(OLDEST_EVER_SHIPPED_MAJOR);
    expect(OLD_FLOOR_SPELLINGS.length).toBeGreaterThan(0);
    expect(FLOOR_SHORT).toBe('22.12');
  });

  it('package.json engines.node states the floor', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe(`>=${FLOOR}`);
  });

  it("vite.config.ts carries exactly one pack target, and it is the floor's major", () => {
    const src = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const targets = [...src.matchAll(/target:\s*'node(\d+)'/g)].map((m) => Number(m[1]));
    // Fail closed: zero targets means the pack block lost its floor; two means
    // a stale copy survived beside the new one and tsdown reads whichever wins.
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(FLOOR_MAJOR);
  });

  it('the runtime-compat CI matrix smokes the EXACT floor first, the dev pin too, and nothing older', () => {
    const ci = parseYaml(
      readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    ) as {
      jobs: Record<string, { strategy?: { matrix?: { 'node-version'?: unknown } } }>;
    };
    const rows = ci.jobs['runtime-compat']?.strategy?.matrix?.['node-version'];
    expect(Array.isArray(rows)).toBe(true);
    // Rows are quoted strings so YAML cannot reshape them (an unquoted 22.10
    // parses as the float 22.1); refuse anything else rather than coerce it.
    for (const row of rows as unknown[]) {
      expect(typeof row, `non-string matrix row ${String(row)}`).toBe('string');
      expect(row as string).toMatch(/^\d+(\.\d+)?$/);
    }
    const versions = rows as string[];
    // The FIRST row is the floor itself, major.minor, so the smoke executes
    // the bundle on the promised minimum — a bare major resolves to the
    // newest 22.x and proves nothing about 22.12.
    expect(versions[0]).toBe(FLOOR_SHORT);
    const majors = versions.map((v) => Number(v.split('.')[0]));
    expect(Math.min(...majors)).toBe(FLOOR_MAJOR);
    expect(majors.every((m) => m >= FLOOR_MAJOR)).toBe(true);
    // The dev / CI pin (`.node-version`) is the runtime the suite itself runs
    // on; the built CLI must be smoked there too, or the matrix can quietly
    // drop the version every contributor actually uses.
    const devPinMajor = Number(
      readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim().split('.')[0]
    );
    expect(majors).toContain(devPinMajor);
  });

  it('the ci-ok comment names the expanded matrix job by the floor row and no other', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain(`runtime-compat (${FLOOR_SHORT})`);
    // Any OTHER expanded name in the file is an example from a row that no
    // longer exists (a bare `(22)` and the retired `(20)` included).
    const escaped = FLOOR_SHORT.replace('.', String.raw`\.`);
    expect(ci).not.toMatch(new RegExp(String.raw`runtime-compat \((?!${escaped}\))\d+(\.\d+)?\)`));
  });

  it('README and CONTRIBUTING state the floor and no older one', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    for (const [name, text] of [
      ['README.md', readme],
      ['CONTRIBUTING.md', contributing],
    ] as const) {
      for (const stale of OLD_FLOOR_SPELLINGS) {
        expect(text, `${name} still says "${stale}"`).not.toContain(stale);
      }
    }
    // The README's Quick start states the floor, in a Node.js context — a
    // bare `22.12` elsewhere (a date, another product's version) is not it.
    const escaped = FLOOR_SHORT.replace('.', String.raw`\.`);
    expect(readme).toMatch(new RegExp(String.raw`Node\.js ${escaped} or later`));
  });
});

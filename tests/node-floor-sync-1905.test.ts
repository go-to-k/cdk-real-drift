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
 * surface move.
 */

const FLOOR = '22.12.0';
const FLOOR_MAJOR = Number(FLOOR.split('.')[0]);

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

// Every read below spells its target as literal `join(REPO_ROOT, ...)` segments
// so tests/check-scope-checker-inputs-1837.test.ts can see it as a checker input.
describe('the published Node.js floor is one value across every surface (#1905)', () => {
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

  it('the runtime-compat CI matrix starts at the floor major and no longer runs 20', () => {
    const ci = parseYaml(
      readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    ) as {
      jobs: Record<string, { strategy?: { matrix?: { 'node-version'?: number[] } } }>;
    };
    const versions = ci.jobs['runtime-compat']?.strategy?.matrix?.['node-version'];
    expect(versions).toEqual([22, 24]);
    expect(Math.min(...(versions ?? []))).toBe(FLOOR_MAJOR);
    expect(versions).not.toContain(20);
  });

  it('the ci-ok comment names the expanded matrix job by a version that still exists', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain(`runtime-compat (${FLOOR_MAJOR})`);
    expect(ci).not.toContain('runtime-compat (20)');
  });

  it('README and CONTRIBUTING no longer state a Node 20 floor', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    for (const [name, text] of [
      ['README.md', readme],
      ['CONTRIBUTING.md', contributing],
    ] as const) {
      for (const stale of ['Node.js 20', 'Node 20', 'v20.x', '>=20']) {
        expect(text, `${name} still says "${stale}"`).not.toContain(stale);
      }
    }
    // The README's Quick start states the floor; keep it on the same literal.
    expect(readme).toContain(`Node.js ${FLOOR.replace(/\.0$/, '')} or later`);
  });
});

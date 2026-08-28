import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Checker-INPUT scope fence (go-to-k/cdk-real-drift#1837).
 *
 * The `check` markgate marker attests that the unit suite was green on the
 * digested tree. That attestation is sound only while every file the suite
 * READS sits inside the gate's `include` — otherwise an edit to a checker input
 * leaves the marker FRESH over a tree the suite would fail on.
 *
 * The class recurs silently and has now been fixed three times across the
 * sibling repos by hand (go-to-k/cdk-local#620, go-to-k/cdk-local#624,
 * go-to-k/cdkd#2041, go-to-k/cdkd#2364), each time found by an audit rather
 * than by anything in the repo. So this fence derives the population from the
 * TESTS (the readers), never from the include list (the remedy — a fence
 * derived from its own remedy goes vacuous): it extracts every repo-relative
 * literal read target from `tests/*.ts` and asserts each existing target
 * outside the structurally-scoped trees is matched by a `check` include glob.
 * A new checker input then fails HERE, at write time, naming the entry to add.
 *
 * Ported from cdkd's tests/unit/scripts/check-scope-checker-inputs.test.ts,
 * with the extraction widened to this repo's dominant idiom
 * (`new URL('../x', import.meta.url)`) and the include parser switched to
 * single-quoted YAML scalars.
 *
 * The literal walk is a CAP: it says every reader it can see is covered. A cap
 * alone rewards the inverse regression — nothing establishes a FLOOR, so a new
 * uncovered file reopens the gap silently. The second describe block below
 * pairs it with one, for the reader whose population is finite and cheap to
 * enumerate (the markdown scanner). That pairing is what makes the narrow
 * `demo/README.md` include entry safe by construction rather than by vigilance.
 *
 * BLIND SPOTS — what this fence CANNOT see, declared rather than implied,
 * because a fence that does not state its limits gets mistaken for total
 * coverage, which is how these three repos accumulated the gaps in the first
 * place. The parser floors below fence the parser going DEAD; they say nothing
 * about idiom coverage, so each of these still needs an include entry added by
 * hand:
 *   (a) a path arriving through a VARIABLE or a lookup table. cdkd's copy hit
 *       this live — cc-protection-doc-coverage.test.ts reads README.md that way
 *       and only human review found it.
 *   (b) template-literal paths.
 *   (c) a bare `import` of a repo file. Live here:
 *       tests/vp-run-check-redirect-1761.test.ts imports '../vite.config.js',
 *       covered only because `vite.config.ts` is in scope for other reasons.
 *   (d) a reader in a SUBDIRECTORY of tests/. `testSources()` is deliberately
 *       non-recursive: every suite this repo runs is a flat `tests/*.ts`
 *       (tests/integration/** is excluded from `vp test run` by vite.config.ts,
 *       and tests/corpus + tests/fixtures hold data, not readers). A future
 *       nested suite is invisible here.
 *   (e) repo-wide scanners whose population really is the whole tree —
 *       tests/skill-doc-paths.test.ts's citation resolution walks every
 *       backticked path token in every skill doc. `.markgate.yml`'s comment
 *       records it as an accepted limit; it fires on a RENAME, not an ordinary
 *       edit, so CI is a proportionate backstop.
 *       tests/markdown-fmt-corruption-1771.test.ts USED to be in this bucket
 *       and no longer is — its population is `git ls-files "*.md"`, which is
 *       finite, so the floor below owns it instead.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

// Trees whose membership is structural rather than per-file: src/tests are the
// gate's own subject, dist/node_modules are outputs, not inputs.
const ALREADY_SCOPED = /^(src|tests|dist|node_modules)(\/|$)/;

function testSources(): string[] {
  const dir = join(REPO_ROOT, 'tests');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/** join|resolve(ROOT|repoRoot|root|REPO_ROOT, 'a', 'b', ...) — literal segments only. */
const JOIN_RE = /(?:join|resolve)\(\s*(?:REPO_ROOT|repoRoot|root|ROOT)\s*((?:,\s*'[^']+')+)\s*\)/g;

/** new URL('../a/b', import.meta.url) and the url('../a/b') helper spelling. */
const URL_RE = /(?:new\s+URL|\burl)\(\s*'(\.\.\/[^']+)'/g;

function extractTargets(): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const add = (rel: string, file: string) => {
    const list = targets.get(rel) ?? [];
    list.push(file.slice(REPO_ROOT.length + 1));
    targets.set(rel, list);
  };
  for (const file of testSources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(JOIN_RE)) {
      const segs = [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      if (segs.some((s) => s.includes('..'))) continue; // escapes the root
      add(segs.join('/'), file);
    }
    for (const m of src.matchAll(URL_RE)) {
      // `tests/x.test.ts` + '../a/b' resolves to repo-root-relative `a/b`.
      const rel = m[1].slice(3);
      if (rel.includes('..')) continue;
      add(rel, file);
    }
  }
  return targets;
}

function checkIncludeGlobs(): string[] {
  const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^ {2}check:/.test(l));
  expect(start, '.markgate.yml has a `check:` gate').toBeGreaterThanOrEqual(0);
  // Anchored to the `include:` sub-block, not the whole gate: a future
  // `exclude:` list parsed as include globs would over-cover and mask a miss.
  let inInclude = false;
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next gate
    if (/^ {4}\S/.test(lines[i])) inInclude = /^ {4}include:/.test(lines[i]);
    const m = lines[i].match(/^ {6}- '([^']+)'/);
    if (m && inInclude) globs.push(m[1]);
  }
  return globs;
}

/** Minimal glob matcher for the include spellings this repo uses. */
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` swallows the slash too
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^$()[]{}|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

describe('check-gate scope covers every literal checker input (go-to-k/cdk-real-drift#1837)', () => {
  const targets = extractTargets();
  const globs = checkIncludeGlobs();
  const res = globs.map(globToRe);

  const covered = (rel: string): boolean =>
    // A directory read (a readdirSync target) is covered when files UNDER it
    // are, so probe a sentinel child as well as the path itself.
    [rel, `${rel}/__sentinel__`].some((c) => res.some((r) => r.test(c)));

  it('parser floor: the extraction sees the known checker inputs', () => {
    // A literal floor, NOT derived from the include list. These reads exist in
    // tests/ today; if one moves, update the floor deliberately.
    for (const known of [
      '.claude/settings.json', // gate-if-matchers-1801.test.ts
      '.claude/skills', // skill-doc-paths / skill-file-payload
      '.claude/hooks', // skill-doc-paths.test.ts's harness block
      '.github/workflows/pr-inherit-issue-labels.yml', // pr-inherit-issue-labels.test.ts
      'scripts/check-pr-title.mjs', // check-pr-title.test.ts
      '.releaserc.json', // releaserc-header-pattern.test.ts
    ]) {
      expect([...targets.keys()], `extraction finds ${known}`).toContain(known);
    }
    expect(globs.length, 'include list parsed').toBeGreaterThanOrEqual(10);
  });

  it('both extraction idioms are live, not just the join form', () => {
    // The URL form is this repo's own addition over cdkd's parser; without a
    // per-idiom floor it could go dead while the join floor above stayed green.
    //
    // THIS FILE IS EXCLUDED FROM THE COUNT, and that exclusion is the whole
    // point. The doc comment above contains illustrative `join(REPO_ROOT, …)`
    // and `new URL('../x', import.meta.url)` spellings, so a floor measured
    // over every file scores 3 join + 3 url from this file ALONE — enough to
    // satisfy any floor at or below those numbers with every real reader in
    // the repo deleted. A floor a fence can satisfy by quoting itself is not a
    // floor. Counted over the other suites: join 5, url 6 (measured on this
    // branch); the floors sit just under, so losing either idiom fails here.
    const self = fileURLToPath(import.meta.url);
    const src = testSources()
      .filter((f) => f !== self)
      .map((f) => readFileSync(f, 'utf8'));
    const joinHits = src.reduce((n, t) => n + [...t.matchAll(JOIN_RE)].length, 0);
    const urlHits = src.reduce((n, t) => n + [...t.matchAll(URL_RE)].length, 0);
    expect(joinHits, 'join/resolve extraction is live').toBeGreaterThanOrEqual(5);
    expect(urlHits, 'new URL extraction is live').toBeGreaterThanOrEqual(6);
  });

  it('no suite hides in a tests/ subdirectory the extractor cannot see', () => {
    // testSources() is deliberately non-recursive (blind spot (d) above), but
    // vite.config.ts's test include is `tests/**/*.test.ts` — so a nested suite
    // WOULD run while being invisible here. Fence the flatness assumption
    // rather than trusting it: tests/integration/** is excluded from the run,
    // and tests/corpus + tests/fixtures hold data, not readers.
    const RUNNABLE_EXEMPT = new Set(['integration']);
    const nested: string[] = [];
    for (const e of readdirSync(join(REPO_ROOT, 'tests'), { withFileTypes: true })) {
      if (!e.isDirectory() || RUNNABLE_EXEMPT.has(e.name)) continue;
      const walk = (dir: string, rel: string) => {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory()) walk(join(dir, f.name), `${rel}/${f.name}`);
          else if (f.name.endsWith('.test.ts')) nested.push(`${rel}/${f.name}`);
        }
      };
      walk(join(REPO_ROOT, 'tests', e.name), `tests/${e.name}`);
    }
    expect(
      nested,
      "suite(s) under a tests/ subdirectory — vitest runs them but this fence's " +
        'extractor only reads tests/*.ts, so any repo file they read is unchecked. ' +
        'Make testSources() recursive (and fix the `../` depth assumption in URL_RE) ' +
        'before adding one'
    ).toEqual([]);
  });

  it('every existing out-of-tree read target is inside the check include', () => {
    const misses: string[] = [];
    for (const [rel, readers] of targets) {
      if (ALREADY_SCOPED.test(rel)) continue;
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue; // fixture-only literals
      try {
        statSync(abs);
      } catch {
        continue;
      }
      // A path counts only when every segment matches the on-disk entry
      // byte-for-byte: APFS folds case, so existsSync says true for an alias.
      const segs = rel.split('/');
      let dir = REPO_ROOT;
      let exact = true;
      for (const seg of segs) {
        if (!readdirSync(dir).includes(seg)) {
          exact = false;
          break;
        }
        dir = join(dir, seg);
      }
      if (!exact) continue;
      if (!covered(rel)) misses.push(`${rel} (read by ${readers.join(', ')})`);
    }
    expect(
      misses,
      'checker input(s) outside the check include — add the path to `check.include` in .markgate.yml (each entry there names its reader), or record it as a repo-wide-scanner known limit'
    ).toEqual([]);
  });

  it('the fence itself fails when a covered entry is dropped (self-probe)', () => {
    // Dropping `.claude/settings.json` from the include must uncover its
    // reader. Simulated rather than left to a manual mutation probe: this is
    // the "watched it go red" half, kept green by inverting it.
    const without = globs.filter((g) => g !== '.claude/settings.json');
    const resWithout = without.map(globToRe);
    const stillCovered = ['.claude/settings.json', '.claude/settings.json/__sentinel__'].some((c) =>
      resWithout.some((r) => r.test(c))
    );
    expect(globs).toContain('.claude/settings.json');
    expect(stillCovered, 'dropping the entry uncovers its reader').toBe(false);
  });

  it('the include parser reads globs, not the surrounding comment prose', () => {
    // The comment block above the entries is long and cites paths in prose; a
    // parser that swallowed a `#   - .claude/settings.json` bullet would cover
    // everything and never miss. Assert it sees only real list items.
    expect(globs).toContain('src/**');
    expect(globs).toContain('.markgate.yml');
    expect(globs.every((g) => !g.startsWith('#'))).toBe(true);
    expect(globs.some((g) => g.includes(' '))).toBe(false);
  });
});

// The FLOOR half. The literal walk above caps what is covered; nothing in it
// establishes a minimum, so a new markdown file — `demo/GUIDE.md`, another root
// `.md` — would reopen go-to-k/cdk-real-drift#1837's G8 silently while every
// assertion above stayed green.
//
// This reader earns a floor where the citation walk does not, because its
// population is FINITE and cheap to enumerate: `git ls-files "*.md"` minus the
// one file it excludes. It is also the reader whose predicate fires on ORDINARY
// content rather than a rare condition — `boldGlobHazard` reds on a bolded run
// containing a code span with `**` in it, the house style of the instruction
// prose in these repos — so leaving it to CI is materially weaker here than the
// same carve-out is in the siblings.
describe('check-gate scope covers the markdown scanner population (floor)', () => {
  const globs = checkIncludeGlobs();
  const res = globs.map(globToRe);

  // Mirrors markdown-fmt-corruption-1771.test.ts's own markdownFiles(): the
  // same command and the same exclusion, so the two cannot drift apart.
  const EXCLUDED = new Set(['CHANGELOG.md']);
  const population = execSync('git ls-files "*.md"', { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => f && !EXCLUDED.has(f));

  it('the population matches the scanner it mirrors (not a no-op)', () => {
    // A floor over an empty population passes vacuously, and `git ls-files`
    // returns nothing in a non-repo cwd or a broken checkout.
    expect(population.length, 'git ls-files "*.md" found markdown').toBeGreaterThanOrEqual(20);
    expect(population).toContain('README.md');
    expect(population).toContain('docs/ARCHITECTURE.md');
    expect(population, 'CHANGELOG.md is excluded, as the scanner excludes it').not.toContain(
      'CHANGELOG.md'
    );

    // The exclusion must stay in sync with the scanner's own. If that test
    // stops excluding CHANGELOG.md (or starts excluding more), this floor is
    // measuring a different set than the suite actually scans.
    const scanner = readFileSync(
      join(REPO_ROOT, 'tests', 'markdown-fmt-corruption-1771.test.ts'),
      'utf8'
    );
    expect(scanner, 'the scanner still globs every tracked *.md').toContain('git ls-files "*.md"');
    expect(scanner, 'the scanner still excludes exactly CHANGELOG.md').toContain(
      "const EXCLUDED = new Set(['CHANGELOG.md']);"
    );
  });

  it('every markdown file the scanner reads is inside the check include', () => {
    const uncovered = population.filter((f) => !res.some((r) => r.test(f)));
    expect(
      uncovered,
      'markdown file(s) scanned by tests/markdown-fmt-corruption-1771.test.ts but NOT digested by ' +
        'the `check` marker — an ordinary prose edit there reds the suite while the marker still ' +
        'verifies FRESH. Add a glob covering each to `check.include` in .markgate.yml (a narrow ' +
        'entry like `demo/README.md` is fine; this floor is what keeps it safe)'
    ).toEqual([]);
  });

  it('the floor fails when the entry covering a narrow case is dropped (self-probe)', () => {
    // `demo/README.md` is deliberately a single file rather than `demo/**`
    // (demo/ holds a .gif and four shell scripts no checker reads). Dropping it
    // must uncover demo/README.md — this is the assertion that lets the narrow
    // entry be safe by construction instead of by vigilance.
    const without = globs.filter((g) => g !== 'demo/README.md').map(globToRe);
    const stillCovered = without.some((r) => r.test('demo/README.md'));
    expect(globs).toContain('demo/README.md');
    expect(stillCovered, 'dropping demo/README.md uncovers it').toBe(false);
    expect(population).toContain('demo/README.md');
  });
});

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
 *   (c2) a `join(<root>, 'x')` whose root identifier is not one of
 *       REPO_ROOT / repoRoot / root / ROOT. A suite spelling it `repo` or
 *       `base` is not extracted (measured: `const repo = …;
 *       readFileSync(join(repo, '.node-version'))` is invisible).
 *   (d) a reader in a SUBDIRECTORY of tests/ or a co-located src suite. `testSources()` is deliberately
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

/**
 * The `check` gate's include and exclude lists, read from .markgate.yml.
 *
 * BOTH are parsed, because markgate 0.4.1 HONOURS `exclude` and subtracts it
 * from the resolved scope. Modelling only `include` is not a conservative
 * simplification, it is the defect this whole file exists to catch, one level
 * up: measured on this branch, adding `exclude: ['docs/**', '.claude/settings
 * .json']` under `check:` takes docs/*.md in `markgate verify check --explain`
 * from 5 to 0 and drops settings.json entirely, while a fence that read only
 * `include` stayed 9/9 GREEN. A future exclude entry would then silently
 * un-scope a checker input with every assertion here still passing.
 */
function checkGateLists(): { include: string[]; exclude: string[]; includeItemLines: number } {
  const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^ {2}check:/.test(l));
  expect(start, '.markgate.yml has a `check:` gate').toBeGreaterThanOrEqual(0);
  let key: 'include' | 'exclude' | null = null;
  const include: string[] = [];
  const exclude: string[] = [];
  let includeItemLines = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next gate
    if (/^ {4}\S/.test(lines[i])) {
      key = /^ {4}include:/.test(lines[i])
        ? 'include'
        : /^ {4}exclude:/.test(lines[i])
          ? 'exclude'
          : null;
      continue;
    }
    // A list ITEM is a 6-space `- '…'`. Comment bullets in the prose block are
    // `#   - <glob> — …` with `#` at column 6, so they can never match.
    if (key === 'include' && /^ {6}- '/.test(lines[i])) includeItemLines++;
    const m = lines[i].match(/^ {6}- '([^']+)'/);
    if (!m || !key) continue;
    (key === 'include' ? include : exclude).push(m[1]);
  }
  return { include, exclude, includeItemLines };
}

function checkIncludeGlobs(): string[] {
  return checkGateLists().include;
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
  const { include: globs, exclude, includeItemLines } = checkGateLists();
  const res = globs.map(globToRe);
  const exRes = exclude.map(globToRe);

  const covered = (rel: string): boolean =>
    // A directory read (a readdirSync target) is covered when files UNDER it
    // are, so probe a sentinel child as well as the path itself. `exclude`
    // SUBTRACTS, exactly as markgate resolves it.
    [rel, `${rel}/__sentinel__`].some(
      (c) => res.some((r) => r.test(c)) && !exRes.some((r) => r.test(c))
    );

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
    const walk = (dir: string, rel: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(dir, f.name), `${rel}/${f.name}`);
        else if (f.name.endsWith('.test.ts')) nested.push(`${rel}/${f.name}`);
      }
    };
    for (const e of readdirSync(join(REPO_ROOT, 'tests'), { withFileTypes: true })) {
      if (!e.isDirectory() || RUNNABLE_EXEMPT.has(e.name)) continue;
      walk(join(REPO_ROOT, 'tests', e.name), `tests/${e.name}`);
    }
    // vite.config.ts's include is BOTH `tests/**/*.test.ts` and
    // `src/**/*.test.ts`; a co-located src suite is equally invisible here.
    walk(join(REPO_ROOT, 'src'), 'src');
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

  it('the include parser reads list items exactly, not the comment prose', () => {
    // The comment block above the entries is long and cites the same paths in
    // `#   - <glob> — <prose>` bullets, so a looser item regex swallows them
    // and over-covers — which makes every assertion above vacuous.
    //
    // Asserting properties of the captured VALUES does not detect that: the
    // bullets' captures start with neither `#` nor a space, so a loosened
    // parser yielding 27 globs instead of 20 passed all of them (measured).
    // The discriminating assertion is a COUNT tied to the item syntax.
    const itemLines = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8')
      .split('\n')
      .filter((l) => /^ {6}- '/.test(l)).length;
    expect(globs.length, 'every parsed glob is a real 6-space list item').toBe(includeItemLines);
    expect(
      includeItemLines,
      'the include block holds every 6-space list item in the file (no other gate uses that shape ' +
        'above `docs:`) — if a sibling gate grows one, scope this count to the check block'
    ).toBeLessThanOrEqual(itemLines);
    expect(globs).toContain('src/**');
    expect(globs).toContain('.markgate.yml');
    expect(new Set(globs).size, 'no glob parsed twice').toBe(globs.length);
    // A real floor, not a token one: the list stands at 20 on this branch.
    expect(globs.length, 'include list parsed in full').toBeGreaterThanOrEqual(18);
  });

  it('the check gate declares no `exclude:` list (and the parser would see one)', () => {
    // markgate 0.4.1 subtracts `exclude` from the resolved scope, so an entry
    // there un-scopes a checker input just as removing an include entry does.
    // covered() models that subtraction; this asserts the simpler invariant the
    // repo actually wants, and fails loudly the day someone adds one.
    expect(
      exclude,
      'the `check` gate grew an `exclude:` list — every entry SUBTRACTS from the marker digest, ' +
        'so confirm no checker input falls inside it before allowing this'
    ).toEqual([]);
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

// The check-scope enumeration in `/check`'s own SKILL.md went stale once
// already: go-to-k/cdk-real-drift#1837 widened the gate and had to repair that
// sentence in the same PR. The PR then defended the repair with another
// sentence ("read .markgate.yml for the authoritative list"), which is the same
// mechanism that just failed. §10-b: a claim that must stay in sync with the
// repo is a TEST, not a request that the next reader remember.
describe('the /check skill doc enumerates the real check-gate scope', () => {
  const globs = checkIncludeGlobs();
  const SKILL = '.claude/skills/check/SKILL.md';

  it('every include entry is named in the skill doc', () => {
    const text = readFileSync(join(REPO_ROOT, SKILL), 'utf8');
    // Each entry is cited as a backticked token somewhere in the doc.
    const missing = globs.filter((g) => !text.includes(`\`${g}\``));
    expect(
      missing,
      `${SKILL} no longer lists every \`check.include\` entry — a reader who trusts it would ` +
        `under-run /check. Add each to the enumeration (or, if the doc deliberately summarises, ` +
        `relax this to the entries it does claim to list)`
    ).toEqual([]);
  });

  it('the skill doc names no entry the gate does not have', () => {
    const text = readFileSync(join(REPO_ROOT, SKILL), 'utf8');
    // Only tokens that LOOK like include globs, so ordinary prose citations
    // (`vp run typecheck`, `dist/`) are not mistaken for scope claims.
    const cited = [...text.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1])
      .filter((t) => /^[A-Za-z0-9_.@*-]+(\/[A-Za-z0-9_.@*-]+)*$/.test(t))
      .filter((t) => t.includes('/') || t.includes('*') || /\.(md|json|ya?ml|toml|ts)$/.test(t));
    const claimed = cited.filter((t) => globs.includes(t));
    // Anti-no-op: the extractor must actually be finding the enumeration.
    expect(claimed.length, 'the doc cites the include entries at all').toBeGreaterThanOrEqual(15);
  });
});

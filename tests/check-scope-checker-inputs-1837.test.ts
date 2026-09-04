import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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
 *   (d2) the repo's ROOT LISTING. skill-doc-paths.test.ts:33 builds PATH_ROOTS
 *       with readdirSync(ROOT), so adding or removing a TOP-LEVEL directory
 *       changes which tokens count as path citations. Unscopeable by any glob;
 *       recorded as a known limit in .markgate.yml.
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
 * The `check` gate's declaration, read from .markgate.yml with a REAL YAML
 * parser (`yaml`, already a production dependency of this repo).
 *
 * A hand-rolled line scanner was tried first and is exactly why this uses a
 * parser now. It recognised only 6-space BLOCK items (`/^ {6}- '/`), so it was
 * blind in both directions at once:
 *   - a FLOW sequence — `exclude: ['docs/**', '.claude/settings.json']` —
 *     parsed to `exclude: []`, so the subtraction below silently did nothing.
 *     Measured against markgate 0.4.1: with that flow-style exclude,
 *     `markgate verify check --explain` resolves README.md alone while the
 *     scanner reported `include: 20, exclude: []`. Flow style is the spelling
 *     this PR's own probes used, so the fence was blind to the exact shape its
 *     author reached for.
 *   - a double-quoted item — `- "docs/**"` — was dropped from `include`,
 *     silently SHRINKING the parsed scope.
 *
 * The general lesson, which is why this is a parser and not a third regex: a
 * fence that re-implements a tool's config parsing must either use a real
 * parser or fail closed on any spelling it does not understand. Adding one
 * more pattern per discovered spelling is how the previous two holes got
 * there. Block, flow, single-quoted, double-quoted and unquoted scalars now
 * all resolve identically, because none of them is this file's concern any
 * more.
 *
 * `exclude` is read because markgate SUBTRACTS it from the resolved scope, so
 * an entry there un-scopes a checker input exactly as deleting an include
 * entry does.
 */
function checkGate(): { include: string[]; exclude: string[]; hash: unknown } {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8')) as {
    gates?: Record<string, { include?: unknown; exclude?: unknown; hash?: unknown }>;
  };
  const gate = doc?.gates?.check;
  expect(gate, '.markgate.yml declares a `check:` gate').toBeTruthy();

  // Fail CLOSED on any shape this fence does not model, naming what it saw.
  // A list it cannot read must never look like an empty list.
  const seq = (v: unknown, key: string): string[] => {
    if (v === undefined || v === null) return [];
    expect(
      Array.isArray(v),
      `check.${key} is not a sequence (got ${typeof v}) — this fence models a list of glob ` +
        `strings; extend the parser rather than reshaping the YAML`
    ).toBe(true);
    for (const e of v as unknown[]) {
      expect(
        typeof e,
        `check.${key} holds a non-string entry (${JSON.stringify(e)}) — extend the parser ` +
          `rather than reshaping the YAML`
      ).toBe('string');
    }
    return v as string[];
  };
  // Fail CLOSED on an unknown key. The authority is markgate's own gate key
  // set (internal/config/config.go), NOT the keys this repo happens to use --
  // deriving the list from local usage is how the `exclude` hole existed in the
  // first place. Of these, `include`/`exclude` decide scope directly and `hash`
  // decides what a match MEANS; `base`, `state_dir`, `ttl`, `composes` and
  // `requires` do not subtract scope (the first three by construction; the last
  // two are reasoned, not probed -- if either is ever added here, verify that
  // before trusting this fence).
  const KNOWN = new Set([
    'hash',
    'include',
    'exclude',
    'base',
    'state_dir',
    'ttl',
    'composes',
    'requires',
  ]);
  const unknown = Object.keys(gate ?? {}).filter((k) => !KNOWN.has(k));
  expect(
    unknown,
    `the \`check\` gate declares key(s) this fence does not model -- it cannot know whether they ` +
      `narrow the digested scope, so it refuses rather than assuming they do not. Extend the ` +
      `parser (and check markgate's config.go for what the key does)`
  ).toEqual([]);

  return {
    include: seq(gate?.include, 'include'),
    exclude: seq(gate?.exclude, 'exclude'),
    hash: gate?.hash,
  };
}

function checkIncludeGlobs(): string[] {
  return checkGate().include;
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
  const { include: globs, exclude, hash } = checkGate();
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
      'release-please-config.json', // release-please-v0.test.ts
      '.release-please-manifest.json', // release-please-v0.test.ts
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
    // floor. Counted over the other suites: join 6, url 13 (re-measured when
    // the CHANGELOG splice-format cases were added to release-please-v0.test.ts,
    // +2 url reads; previously join 6, url 11 when
    // release-please-v0.test.ts replaced releaserc-header-pattern.test.ts;
    // the replacement reads its four subjects through the url idiom), and the
    // floors sit AT those numbers with ZERO headroom, not just
    // under. That is deliberate: the failure being fenced is an idiom going
    // dead, and a floor of 1 would not notice four of five readers vanishing.
    // The accepted cost is that legitimately deleting one reader reds this and
    // must be paid for by re-measuring the floor in the same commit -- a
    // maintenance cost taken knowingly rather than discovered.
    const self = fileURLToPath(import.meta.url);
    const src = testSources()
      .filter((f) => f !== self)
      .map((f) => readFileSync(f, 'utf8'));
    const joinHits = src.reduce((n, t) => n + [...t.matchAll(JOIN_RE)].length, 0);
    const urlHits = src.reduce((n, t) => n + [...t.matchAll(URL_RE)].length, 0);
    expect(joinHits, 'join/resolve extraction is live').toBeGreaterThanOrEqual(6);
    expect(urlHits, 'new URL extraction is live').toBeGreaterThanOrEqual(13);
  });

  it('no suite hides in a tests/ subdirectory the extractor cannot see', () => {
    // testSources() is deliberately non-recursive (blind spot (d) above), but
    // vite.config.ts's test include is `tests/**/*.test.ts` — so a nested suite
    // WOULD run while being invisible here. Fence the flatness assumption
    // rather than trusting it: tests/integration/** is excluded from the run,
    // and tests/corpus + tests/fixtures hold data, not readers.
    // DERIVED from vite.config.ts, not asserted about it. The previous version
    // hard-coded `integration` and justified it with a comment describing what
    // the config says — correct on the day it was written and silently wrong
    // the day the config changes, which is this PR's own subject.
    const viteConfig = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const excludeLine = viteConfig.match(/exclude:\s*\[([^\]]*)\]/g) ?? [];
    const excluded = excludeLine
      .flatMap((b) => [...b.matchAll(/'([^']+)'/g)].map((m) => m[1]))
      .filter((e) => e.startsWith('tests/'))
      .map((e) => e.replace(/^tests\//, '').replace(/\/\*\*$/, ''));
    expect(
      excluded,
      "vite.config.ts's test exclude no longer names any tests/ subdirectory — if the integration " +
        'suite stopped being excluded it is now RUN, and this fence must stop exempting it'
    ).toContain('integration');
    const RUNNABLE_EXEMPT = new Set(excluded);
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

  it('no include entry is DEAD (every glob matches a tracked file)', () => {
    // go-to-k/cdk-local#630's class: an entry matching nothing looks like scope
    // and provides none. markgate only errors when the WHOLE include is dead,
    // and `markgate config lint` reports per-entry but runs in no test and no CI
    // job -- so without this, "all 20 globs match" is a hand check that rots.
    const tracked = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const dead = globs.filter((g) => {
      const re = globToRe(g);
      return !tracked.some((f) => re.test(f));
    });
    expect(
      dead,
      'include entr(ies) matching no tracked file -- they read as scope and digest nothing. ' +
        'Remove them, or fix the glob to match what it was meant to cover'
    ).toEqual([]);
    // Anti-no-op: the listing must have actually been read.
    expect(tracked.length, 'git ls-files returned the tree').toBeGreaterThanOrEqual(100);
  });

  it('the include list is parsed in full, with no duplicates', () => {
    // With a real YAML parser there is no line-shape to guard any more: the
    // previous hand-rolled scanner needed a count tied to its own item regex,
    // and the companion `includeItemLines <= itemLines` check was tautological
    // (a strict subset counted with the same regex in a narrower loop). Both
    // are gone with the scanner. What remains worth asserting is that the list
    // is really there and really distinct.
    expect(globs).toContain('src/**');
    expect(globs).toContain('.markgate.yml');
    expect(new Set(globs).size, 'no glob listed twice').toBe(globs.length);
    expect(globs.length, 'include list parsed in full').toBeGreaterThanOrEqual(18);
  });

  it('the check gate still hashes file CONTENT, not a branch diff', () => {
    // `hash: diff` digests this branch's delta against a base ref, so an
    // in-scope change arriving from main stops invalidating the marker. That is
    // the right trade for an expensive real-AWS gate (this repo makes it for
    // `integ`), and it is exactly wrong for `check`, whose whole purpose here is
    // that ANY checker input differing from what was verified stales the marker.
    // A flip would undo this PR's goal for incoming changes, invisibly.
    expect(
      hash,
      'the `check` gate left `hash: files` — under `hash: diff` an in-scope change merged from ' +
        'main no longer stales the marker, which re-opens go-to-k/cdk-real-drift#1837 for every ' +
        'incoming change'
    ).toBe('files');
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
  const { include: globs, exclude } = checkGate();
  const res = globs.map(globToRe);
  const exRes = exclude.map(globToRe);
  // Subtract `exclude` here too. The cap's own guard asserts the gate declares
  // none today, but this floor's containment claim must not be conditional on
  // that guard holding — the two are independent assertions and one of them
  // being green is not evidence about the other.
  const inScope = (f: string) => res.some((r) => r.test(f)) && !exRes.some((r) => r.test(f));

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
    const uncovered = population.filter((f) => !inScope(f));
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
    const stillCovered =
      without.some((r) => r.test('demo/README.md')) && !exRes.some((r) => r.test('demo/README.md'));
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

  it('the skill doc claims no scope entry the gate does not have', () => {
    // The INVERSE of the assertion above, and it has to be scoped to the
    // enumeration itself. A whole-file version is not this invariant: the doc
    // legitimately cites `tests/integration/**` (excluded from `vp test run`)
    // and `wt-*` (branch naming), neither of which is a gate entry.
    //
    // The previous version of this test asserted nothing of the kind — it
    // computed `cited.filter(t => globs.includes(t)).length >= 15`, which is
    // the INTERSECTION, not the complement, and was strictly implied by the
    // test above (all 20 entries appear backticked, so the count was always
    // >= 20). Adding `bogus/**` to the doc left it green.
    const text = readFileSync(join(REPO_ROOT, SKILL), 'utf8');
    const from = text.indexOf('that scope is');
    const to = text.indexOf('A markdown edit therefore');
    expect(from, `${SKILL} still contains the scope enumeration`).toBeGreaterThanOrEqual(0);
    expect(to, `${SKILL} still contains the sentence after the enumeration`).toBeGreaterThan(from);

    const region = text.slice(from, to);
    // A token is a SCOPE CLAIM when it is path- or glob-shaped, or a root-level
    // file. The root-file half is load-bearing: half the include list
    // (`README.md`, `.markgate.yml`, `package.json`, …) has neither a slash nor
    // a star, so a path-shaped-only filter saw 10 of the 20 claims and the
    // anti-no-op floor below caught that as a red before it could ship.
    const ROOT_FILE = /^[.A-Za-z][\w.*-]*\.(md|json|ya?ml|toml|ts|mjs)$/;
    const cited = [...region.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1])
      .filter((t) => t.includes('/') || t.includes('*') || ROOT_FILE.test(t))
      // A reader test may be cited BY PATH as the reason an entry exists.
      .filter((t) => !t.endsWith('.test.ts'));

    // Anti-no-op, measured not guessed: the region carries all 20 claims today.
    expect(cited.length, 'the enumeration region really lists the scope').toBeGreaterThanOrEqual(
      18
    );
    const notEntries = cited.filter((t) => !globs.includes(t));
    expect(
      notEntries,
      `${SKILL}'s scope enumeration names path(s) the \`check\` gate does not include — a reader ` +
        `would believe an edit there stales the marker when it does not. Remove them from the ` +
        `enumeration, or add them to \`check.include\` in .markgate.yml`
    ).toEqual([]);
  });
});

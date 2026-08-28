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
 * Extraction is deliberately LITERAL-ONLY. KNOWN LIMITS, stated because the
 * parser floor below fences only the parser going dead, not idiom coverage:
 * (a) a path arriving through a VARIABLE or a table; (b) template literals;
 * (c) a bare `import` of a repo file (tests/vp-run-check-redirect-1761.test.ts
 * imports '../vite.config.js', which is in scope for other reasons);
 * (d) repo-wide scanners — tests/markdown-fmt-corruption-1771.test.ts's
 * `git ls-files "*.md"` walk and tests/skill-doc-paths.test.ts's citation
 * resolution — whose population is the whole tree. `.markgate.yml`'s comment
 * records how each of those is handled. When a new test reads a repo file
 * through one of those shapes, add the include entry by hand.
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
const URL_RE = /(?:new\s+URL|url)\(\s*'(\.\.\/[^']+)'/g;

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
    const src = testSources().map((f) => readFileSync(f, 'utf8'));
    const joinHits = src.reduce((n, s) => n + [...s.matchAll(JOIN_RE)].length, 0);
    const urlHits = src.reduce((n, s) => n + [...s.matchAll(URL_RE)].length, 0);
    expect(joinHits, 'join/resolve extraction is live').toBeGreaterThanOrEqual(3);
    expect(urlHits, 'new URL extraction is live').toBeGreaterThanOrEqual(2);
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

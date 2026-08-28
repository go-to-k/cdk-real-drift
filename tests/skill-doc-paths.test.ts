import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Guard against a skill doc making a citation that does not resolve — a repo PATH
// that is not there, or an issue reference that resolves to the WRONG repository.
//
// `.claude/skills/**` markdown — SKILL.md orchestrators and the per-stage
// `references/*.md` files alike — is instruction prose an agent ACTS on, and nothing
// lints it: a stale `src/…` path or a `tests/unit/**` that this repo never had
// sends the next session to a directory that is not there, and the mistake is only
// found by a human reading the run afterwards. #1767 mirrored a lesson from the
// sibling repo whose wording named `tests/unit/**` — a real path THERE, absent
// here — which is exactly this failure and exactly what this test now catches.
//
// SCOPE (deliberately narrow, zero false positives on the current tree): only
// inline-code spans whose FIRST segment is a real top-level entry of this repo are
// treated as path citations, so `npm i <pkg>`, `key=value`, URLs and prose in
// backticks are left alone. Placeholder-bearing spans (`<name>`) are skipped —
// they resolve per invocation, not statically.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');

// A backticked token is a PATH citation when its first segment is a real
// top-level entry of this repo. DERIVED, not listed: the hand-kept list said
// `src tests docs .claude .github` while `scripts/` and `demo/` are equally real
// top-level directories, so a stale `scripts/…` citation was invisible to the
// scan (measured 2026-08-20, go-to-k/cdk-real-drift#1797). Build outputs and
// dependency trees are excluded — nothing in a skill doc should cite them.
const NON_CITABLE_ROOTS = new Set(['node_modules', 'dist', 'coverage', '.git', '.worktrees']);
const PATH_ROOTS = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !NON_CITABLE_ROOTS.has(e.name))
  .map((e) => e.name);

const PATH_LIKE = /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.*@-]+)+$/;

// EVERY skill doc owes fully-qualified issue references: a bare `#N` renders
// against whichever repo is READING it, so mirroring a sentence into a sibling
// repo silently rewrites a correct citation into a wrong one. Both failure shapes
// were live on 2026-08-19 (go-to-k/cdk-real-drift#1774) — this repo's `#1761`
// resolves in cdkd to an unrelated EC2 security-group-rule issue, and its `#1765`
// does not exist in cdk-local at all, which already shipped a bare `#1765` meaning
// this repo's.
//
// The population used to be the ONE file this flow mirrors wholesale, on the
// reasoning that `hunt-bugs` never travels. That stopped being true the day
// go-to-k/cdk-real-drift#1796 and its cdk-local twin landed the same `hunt-bugs`
// change in both repos, and the exclusion was hiding 98 bare refs in exactly the
// file the rule had stopped covering. A doc is in scope because a SENTENCE of it
// can travel, which is true of all of them — so the population is derived, not
// listed (2026-08-20, go-to-k/cdk-real-drift#1797).
// (assigned after skillDocs is declared — see below)
let MIRRORED_DOCS: string[] = [];

// A reference is qualified only when a WHOLE `owner/repo` immediately precedes
// the `#`. The first version asked for "not a word, slash or dash character
// before the `#`", which accepts both HALF-qualified spellings — `cdk-real-drift#5`
// (owner dropped) and `go-to-k#5` (repo dropped) — and GitHub autolinks neither,
// so the likeliest typo in a file full of `go-to-k/cdk-real-drift#…` was the one
// the fence could not see (probed 2026-08-20, go-to-k/cdk-real-drift#1797).
// Matches deliberately skip inline-code spans and fenced blocks, so a paragraph
// can still SHOW a bare `#N` as its own counter-example, and skip YAML
// frontmatter, where `argument-hint` demonstrates what a user types.
const ANY_REF = /([A-Za-z0-9._/-]*)#(\d+)/g;
const QUALIFIER = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function unqualifiedRefs(text: string): string[] {
  return [...text.matchAll(ANY_REF)]
    .filter((m) => !QUALIFIER.test(m[1]!))
    .map((m) => `${m[1]}#${m[2]}`);
}

function prose(text: string): string {
  const withoutFrontmatter = text.startsWith('---\n')
    ? text.slice(text.indexOf('\n---\n', 3) + 5)
    : text;
  return (
    withoutFrontmatter
      .replace(/^```[\s\S]*?^```/gm, '') // fenced code blocks
      // DOUBLE-backtick spans first: that is how a counter-example containing a
      // backtick is written, and a single-span-only strip leaves its contents
      // exposed as prose, which the fence then reports as a violation.
      .replace(/``.*?``/g, '')
      .replace(/`[^`\n]*`/g, '') // inline code spans
  );
}

// The population is every `.md` under each skill's directory — the SKILL.md
// orchestrator AND the per-stage `references/*.md` files a split skill loads at
// stage entry (work-issues / hunt-bugs since the 2026-08-28 split). Deriving it
// from the directory, not a list: a SKILL.md-only population would have let the
// split silently move 95% of the prose out of this fence's scope.
function skillDocs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const docs: string[] = [];
  for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join('.claude', 'skills', e.name, 'SKILL.md');
    if (existsSync(path.join(ROOT, skillMd))) docs.push(skillMd);
    const refsDir = path.join(SKILLS_DIR, e.name, 'references');
    if (existsSync(refsDir)) {
      for (const f of readdirSync(refsDir).sort()) {
        if (f.endsWith('.md')) docs.push(path.join('.claude', 'skills', e.name, 'references', f));
      }
    }
  }
  return docs;
}

MIRRORED_DOCS = skillDocs();

function citations(rel: string): string[] {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (token.includes('<') || token.includes('>')) continue; // <placeholder>
    if (!PATH_LIKE.test(token)) continue;
    if (!PATH_ROOTS.includes(token.split('/')[0])) continue;
    found.add(token);
  }
  return [...found].sort();
}

/**
 * Resolve a citation against the repo. Globs are satisfied by ONE match: a
 * trailing `**` only requires its prefix directory, and a `*`-bearing segment
 * requires at least one entry matching it — in ANY position, not only the last
 * one. The first version handled a wildcard in the final segment only, so a
 * perfectly real `.claude/skills/*\/SKILL.md` citation was reported as stale
 * (go-to-k/cdk-real-drift#1797).
 */
function resolves(citation: string): boolean {
  const segmentRe = (segment: string) =>
    new RegExp(`^${segment.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);

  const walk = (dir: string, segments: string[]): boolean => {
    if (segments.length === 0) return true;
    const [head, ...rest] = segments as [string, ...string[]];
    if (head === '**') return true; // `dir/**` and `dir/**/*.sh`: the prefix is the assertion
    const here = path.join(dir, head);
    if (!head.includes('*')) {
      if (!existsSync(here)) return false;
      if (rest.length === 0) return true;
      return statSync(here).isDirectory() && walk(here, rest);
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    const re = segmentRe(head);
    return readdirSync(dir).some((entry) => {
      if (!re.test(entry)) return false;
      if (rest.length === 0) return true;
      const next = path.join(dir, entry);
      return statSync(next).isDirectory() && walk(next, rest);
    });
  };

  return walk(ROOT, citation.split('/'));
}

describe('skill docs cite real repo paths', () => {
  const docs = skillDocs();

  it('finds the skill docs to check', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  it('every repo path cited in a skill doc resolves', () => {
    const missing: string[] = [];
    for (const rel of docs) {
      for (const citation of citations(rel)) {
        if (!resolves(citation)) missing.push(`${rel} -> ${citation}`);
      }
    }
    expect(missing, `stale path citation(s) in skill docs:\n${missing.join('\n')}`).toEqual([]);
  });

  it('actually inspects a meaningful number of citations (the extractor is not a no-op)', () => {
    const total = docs.reduce((n, rel) => n + citations(rel).length, 0);
    // 89 measured on 2026-08-28 across 21 docs (SKILL.md + references/); the
    // floor sits above the ~20 the SKILL.md-only population yielded, so a
    // population regression back to orchestrators-only fails here.
    expect(total).toBeGreaterThanOrEqual(60);
  });
});

describe('mirrored skill docs cite issues by fully-qualified reference', () => {
  it.each(MIRRORED_DOCS)('%s uses owner/repo#N, never a bare #N', (rel) => {
    const text = prose(readFileSync(path.join(ROOT, rel), 'utf8'));
    const bare = unqualifiedRefs(text);
    expect(
      bare,
      `unqualified issue reference(s) in ${rel} — write go-to-k/<repo>#N so the ` +
        `reference survives being mirrored into a sibling repo (a half-qualified ` +
        `cdk-real-drift#N or go-to-k#N autolinks nowhere):\n${bare.join(', ')}`
    ).toEqual([]);
  });

  it('flags every unqualified spelling and exempts the backtick forms (spelling probe)', () => {
    expect(unqualifiedRefs(prose('A bare #601 ref.'))).toEqual(['#601']);
    expect(unqualifiedRefs(prose('A repo-only cdk-real-drift#602 ref.'))).toEqual([
      'cdk-real-drift#602',
    ]);
    expect(unqualifiedRefs(prose('An owner-only go-to-k#603 ref.'))).toEqual(['go-to-k#603']);
    expect(unqualifiedRefs(prose('A parenthesised (PR #604) ref.'))).toEqual(['#604']);
    expect(unqualifiedRefs(prose('A qualified go-to-k/cdk-real-drift#605 ref.'))).toEqual([]);
    expect(unqualifiedRefs(prose('A span `#606` is exempt.'))).toEqual([]);
    expect(unqualifiedRefs(prose('A span ``#607 with `ticks` `` is exempt too.'))).toEqual([]);
  });

  // Anti-no-op guard on the TOTAL, not per doc: a skill that cites nothing is
  // legitimate (`check-docs` has no refs at all), so a per-doc floor would only
  // measure how chatty each file is. What must never happen is the extractor
  // matching nothing anywhere.
  it('the qualified references it should be finding are actually there', () => {
    const qualified = MIRRORED_DOCS.reduce((n, rel) => {
      const text = prose(readFileSync(path.join(ROOT, rel), 'utf8'));
      return n + [...text.matchAll(/[\w-]+\/[\w-]+#\d+/g)].length;
    }, 0);
    // 210 measured on 2026-08-28 across the widened population (SKILL.md +
    // references/); above the ~50 the SKILL.md-only population carried, so a
    // regression back to orchestrators-only fails here too.
    expect(qualified, 'no qualified refs anywhere — extractor is a no-op').toBeGreaterThanOrEqual(
      120
    );
  });
});

// `.claude/skills/work-issues/references/implement.md` §5 tells the next agent to run a hook
// harness FROM `.claude/hooks/` and never from a copy parked elsewhere. That rule is
// only true while every harness resolves its subject from its OWN script path with no
// env override — the day one grows a `HOOK=` escape hatch, §5 becomes stale prose
// that nothing re-checks. §10-b: a claim that must stay in sync with the repo is a
// TEST, not a sentence asking the next reader to remember.
//
// The failure it guards is silent-looking: measured 2026-08-19
// (go-to-k/cdk-real-drift#1777), `worktree-guard.test.sh` scores PASS=13 FAIL=0 run
// in place and PASS=0 FAIL=13 copied out — every case failing on exit 127 because the
// sibling `.sh` is not beside the copy — which reads as a regression the agent's own
// change caused.
describe('hook harnesses resolve their subject from their own script path', () => {
  const HOOKS_DIR = path.join(ROOT, '.claude', 'hooks');
  const entries = existsSync(HOOKS_DIR) ? readdirSync(HOOKS_DIR).sort() : [];
  // The population is the HOOKS, not the harnesses. Deriving it from
  // `*.test.sh` counted the harnesses that exist and so could never report the
  // one that does not: on 2026-08-20 `check-gate.sh` — the hook every commit
  // passes through — was the only hook in the directory with no harness beside
  // it, and this block was green at 9/9 (go-to-k/cdk-real-drift#1797).
  const hooks = entries.filter((f) => f.endsWith('.sh') && !f.endsWith('.test.sh'));
  const harnesses = entries.filter((f) => f.endsWith('.test.sh'));

  it('finds the hooks to check (the extractor is not a no-op)', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(9);
    expect(hooks).toContain('check-gate.sh');
  });

  it('every hook has a harness beside it', () => {
    const unharnessed = hooks.filter((f) => !harnesses.includes(f.replace(/\.sh$/, '.test.sh')));
    expect(
      unharnessed,
      `hook(s) with no .test.sh beside them — a gate nothing exercises is a gate ` +
        `nobody has watched go red:\n${unharnessed.join('\n')}`
    ).toEqual([]);
  });

  it.each(harnesses)('%s derives its subject from its own path', (file) => {
    const text = readFileSync(path.join(HOOKS_DIR, file), 'utf8');
    // Two shapes, both self-relative: a `HOOK=` assignment naming the gate under
    // test, or a `.`-source of a sibling LIBRARY (`_command-match.sh` is exercised
    // by sourcing it, so it has no single subject to assign).
    const assignment =
      text.match(/^HOOK=.*$/m)?.[0] ?? text.match(/^\.\s+"\$\(cd .*_[a-z-]+\.sh"$/m)?.[0];
    expect(assignment, `${file} has no self-relative subject to check`).toBeDefined();
    // The two interchangeable spellings §5 names, and nothing else.
    expect(
      assignment,
      `${file} must resolve its hook via $(dirname "$0") or $(dirname "\${BASH_SOURCE[0]}")`
    ).toMatch(/\$\(dirname "(\$0|\$\{BASH_SOURCE\[0\]\})"\)/);
    // No `${HOOK_OVERRIDE:-…}` escape hatch. If one is added deliberately, amend §5
    // rather than deleting this — the instruction is what depends on it.
    expect(assignment, `${file} gained an env override for its subject — amend §5`).not.toMatch(
      /:-/
    );
  });
});

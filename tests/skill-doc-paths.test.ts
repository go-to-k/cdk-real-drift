import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Guard against a skill doc making a citation that does not resolve — a repo PATH
// that is not there, or an issue reference that resolves to the WRONG repository.
//
// `.claude/skills/**/SKILL.md` is instruction prose an agent ACTS on, and nothing
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

// A reference is qualified when `owner/repo` immediately precedes the `#`. Matches
// deliberately skip inline-code spans and fenced blocks, so a paragraph can still
// SHOW a bare `#N` as its own counter-example, and skip YAML frontmatter, where
// `argument-hint` demonstrates what a user types rather than citing anything.
const BARE_REF = /(?<![\w/-])#\d+/g;

function prose(text: string): string {
  const withoutFrontmatter = text.startsWith('---\n')
    ? text.slice(text.indexOf('\n---\n', 3) + 5)
    : text;
  return withoutFrontmatter
    .replace(/^```[\s\S]*?^```/gm, '') // fenced code blocks
    .replace(/`[^`\n]*`/g, ''); // inline code spans
}

function skillDocs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join('.claude', 'skills', e.name, 'SKILL.md'))
    .filter((rel) => existsSync(path.join(ROOT, rel)));
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
 * Resolve a citation against the repo. Globs are satisfied by ONE match:
 * a trailing `**` only requires its prefix directory, and a `*`-bearing final
 * segment requires at least one sibling entry matching it.
 */
function resolves(citation: string): boolean {
  if (!citation.includes('*')) return existsSync(path.join(ROOT, citation));

  const segments = citation.split('/');
  const wildcardAt = segments.findIndex((s) => s.includes('*'));
  const prefix = path.join(ROOT, ...segments.slice(0, wildcardAt));
  if (!existsSync(prefix) || !statSync(prefix).isDirectory()) return false;

  const segment = segments[wildcardAt];
  // `dir/**` (and `dir/**/*.sh`): the prefix directory existing is the assertion.
  if (segment === '**') return true;
  // `dir/*.json`: at least one entry must match, and nothing may follow it.
  if (wildcardAt !== segments.length - 1) return false;
  const re = new RegExp(`^${segment.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
  return readdirSync(prefix).some((entry) => re.test(entry));
}

describe('skill docs cite real repo paths', () => {
  const docs = skillDocs();

  it('finds the skill docs to check', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  it('every repo path cited in a SKILL.md resolves', () => {
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
    expect(total).toBeGreaterThanOrEqual(20);
  });
});

describe('mirrored skill docs cite issues by fully-qualified reference', () => {
  it.each(MIRRORED_DOCS)('%s uses owner/repo#N, never a bare #N', (rel) => {
    const text = prose(readFileSync(path.join(ROOT, rel), 'utf8'));
    const bare = [...text.matchAll(BARE_REF)].map((m) => m[0]);
    expect(
      bare,
      `unqualified issue reference(s) in ${rel} — write go-to-k/<repo>#N so the ` +
        `reference survives being mirrored into a sibling repo:\n${bare.join(', ')}`
    ).toEqual([]);
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
    expect(qualified, 'no qualified refs anywhere — extractor is a no-op').toBeGreaterThanOrEqual(
      50
    );
  });
});

// `.claude/skills/work-issues/SKILL.md` §5 tells the next agent to run a hook
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
    const assignment = readFileSync(path.join(HOOKS_DIR, file), 'utf8').match(/^HOOK=.*$/m)?.[0];
    expect(assignment, `${file} has no HOOK= assignment to check`).toBeDefined();
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

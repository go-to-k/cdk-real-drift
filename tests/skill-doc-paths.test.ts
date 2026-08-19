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

// Only these roots make a backticked token a PATH citation rather than prose.
const PATH_ROOTS = ['src', 'tests', 'docs', '.claude', '.github'];

const PATH_LIKE = /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.*@-]+)+$/;

// Skill docs that §10-c of `.claude/skills/work-issues/SKILL.md` mirrors into the
// sibling repos (`../cdkd`, `../cdk-local`). Only these owe fully-qualified issue
// references: a bare `#N` renders against whichever repo is READING it, so the
// mirror silently rewrites a correct citation into a wrong one. Both failure
// shapes were live on 2026-08-19 (go-to-k/cdk-real-drift#1774) — this repo's
// `#1761` resolves in cdkd to an unrelated EC2 security-group-rule issue, and its
// `#1765` does not exist in cdk-local at all, which already shipped a bare `#1765`
// meaning this repo's. `hunt-bugs` is deliberately NOT listed: §10-b records that
// this flow never mirrors it, and it carries ~99 bare refs that are correct where
// they are.
const MIRRORED_DOCS = [path.join('.claude', 'skills', 'work-issues', 'SKILL.md')];

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

  it('the qualified references it should be finding are actually there', () => {
    for (const rel of MIRRORED_DOCS) {
      const text = prose(readFileSync(path.join(ROOT, rel), 'utf8'));
      const qualified = [...text.matchAll(/[\w-]+\/[\w-]+#\d+/g)];
      expect(
        qualified.length,
        `${rel} has no qualified refs — extractor is a no-op`
      ).toBeGreaterThanOrEqual(10);
    }
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
  const harnesses = existsSync(HOOKS_DIR)
    ? readdirSync(HOOKS_DIR)
        .filter((f) => f.endsWith('.test.sh'))
        .sort()
    : [];

  it('finds the harnesses to check (the extractor is not a no-op)', () => {
    expect(harnesses.length).toBeGreaterThanOrEqual(9);
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

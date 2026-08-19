import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Guard against a skill doc citing a repo path that does not exist.
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

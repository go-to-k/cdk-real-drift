// The `pr-title-check` workflow enforces that a PR title carries a SINGLE conventional-commit
// type with an optional single scope. A COMPOUND title like `fix(read)+fix(revert): …` passes
// the lenient `amannn/action-semantic-pull-request` gate but (1) historically failed to release
// at all — semantic-release's headerPattern scope class `[^)]+` cannot span the mid-header `)`
// (#1431/#1446 shipped unpublished; fixed in #1448) — and (2) renders an ugly CHANGELOG scope
// (`read)+fix(revert`). This drives the SHIPPED validator exactly as the workflow does — the CLI
// `node scripts/check-pr-title.mjs "<title>"` (exit 0 = accepted, 1 = rejected) — so the test
// pins the real gate behavior without importing the untyped `.mjs` into the type-checker.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const SCRIPT = fileURLToPath(new URL('../scripts/check-pr-title.mjs', import.meta.url));

// Run the validator CLI; return true if it accepted the title (exit 0), false if it rejected it.
function accepts(title: string): boolean {
  try {
    execFileSync('node', [SCRIPT, title], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('check-pr-title CLI — single conventional type + optional single scope', () => {
  it('rejects the COMPOUND title that shipped #1431 unpublished', () => {
    expect(accepts('fix(read)+fix(revert): record-endorse + real delete (#1431)')).toBe(false);
  });

  it('rejects other compound forms', () => {
    expect(accepts('feat(a)+fix(b): thing')).toBe(false);
    expect(accepts('fix(read)+revert: thing')).toBe(false);
  });

  it('accepts a single scoped type', () => {
    expect(accepts('fix(revert): converge a thing')).toBe(true);
    expect(accepts('feat(read): add an override')).toBe(true);
  });

  it('accepts a no-scope type (subject may contain parens)', () => {
    expect(accepts('fix: handle the (#123) edge case')).toBe(true);
    expect(accepts('docs: update README')).toBe(true);
  });

  it('accepts a breaking-change marker', () => {
    expect(accepts('feat(api)!: drop the legacy flag')).toBe(true);
    expect(accepts('feat!: drop the legacy flag')).toBe(true);
  });

  it('accepts the release bot chore(release): commit form', () => {
    expect(accepts('chore(release): 0.12.74 [skip ci]')).toBe(true);
  });

  it('rejects an unknown type, a missing colon, and an empty subject', () => {
    expect(accepts('wip(read): thing')).toBe(false);
    expect(accepts('fix add a thing')).toBe(false);
    expect(accepts('fix(read): ')).toBe(false);
    expect(accepts('')).toBe(false);
  });

  it('accepts every conventional type the release pipeline knows', () => {
    for (const t of [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]) {
      expect(accepts(`${t}: a subject`)).toBe(true);
    }
  });
});

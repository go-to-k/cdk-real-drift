// The semantic-release `headerPattern` in `.releaserc.json` must parse a
// COMPOUND conventional-commit type like `fix(read)+fix(revert): …` as a releasing `fix`.
// The original pattern's scope class `[^)]+` forbade a `)`, so a compound title (which has a
// `)` mid-header before the colon) failed to match ENTIRELY → the commit parsed as no type →
// semantic-release logged "no release" and never published. A real merge (#1431, squash title
// `fix(read)+fix(revert): …`) shipped to main with NO version bump because of exactly this.
// The fix makes the scope non-greedy (`(.+?)`), which absorbs the extra `)` yet still parses
// every single-scope / no-scope title identically. This test pins that contract.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const releaserc = JSON.parse(
  readFileSync(fileURLToPath(new URL('../.releaserc.json', import.meta.url)), 'utf8')
) as {
  plugins: unknown[];
};

// EVERY plugin that PARSES commits needs the pattern, not just the one that decides the
// bump. This test used to look `@semantic-release/commit-analyzer` up by name, so
// `@semantic-release/release-notes-generator` — configured as a bare string, and therefore
// falling back to conventional-changelog-angular's default `^(\w*)(?:\((.*)\))?: (.*)$`,
// which has no `!` — was outside its population entirely. The consequence shipped: all 13
// `type!:` / `type(scope)!:` merges in this repo's history released a version and left NO
// entry in `CHANGELOG.md` (checked 2026-08-20 for go-to-k/cdk-real-drift#432, #105, #93,
// #73 and #57 — zero hits each, and the file has no BREAKING section at all).
// go-to-k/cdk-real-drift#1797.
const COMMIT_PARSING_PLUGINS = [
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
];

function parserOptsOf(name: string): { headerPattern: string; headerCorrespondence: string[] } {
  const plugin = releaserc.plugins.find(
    (p): p is [string, { parserOpts: { headerPattern: string; headerCorrespondence: string[] } }] =>
      Array.isArray(p) && p[0] === name
  );
  expect(
    plugin,
    `${name} must carry its own parserOpts, not fall back to the preset`
  ).toBeDefined();
  return plugin![1].parserOpts;
}

const headerPattern = parserOptsOf('@semantic-release/commit-analyzer').headerPattern;
const re = new RegExp(headerPattern);

const parse = (header: string): { type?: string; scope?: string; breaking?: string } => {
  const m = re.exec(header);
  return m ? { type: m[1], scope: m[2], breaking: m[3] } : {};
};

describe('.releaserc.json headerPattern', () => {
  it('every commit-parsing plugin carries the SAME parserOpts', () => {
    for (const name of COMMIT_PARSING_PLUGINS) {
      const opts = parserOptsOf(name);
      expect(opts.headerPattern, `${name} headerPattern drifted`).toBe(headerPattern);
      expect(opts.headerCorrespondence).toContain('breaking');
    }
  });

  it('parses a BREAKING `type!:` title, so the entry reaches the release notes', () => {
    expect(parse('feat!: drop the legacy flag')).toEqual({
      type: 'feat',
      scope: undefined,
      breaking: '!',
    });
    expect(parse('feat(api)!: drop the legacy flag')).toEqual({
      type: 'feat',
      scope: 'api',
      breaking: '!',
    });
  });

  it('parses a COMPOUND `fix(x)+fix(y):` title as a releasing `fix` (the #1431 no-release bug)', () => {
    const p = parse('fix(read)+fix(revert): record-endorse + real delete (#1431) (#1446)');
    expect(p.type).toBe('fix'); // NOT undefined → semantic-release applies the `fix` → patch rule
  });

  it('parses a compound `feat(x)+fix(y):` title as `feat`', () => {
    expect(parse('feat(read)+fix(revert): add a thing (#42)').type).toBe('feat');
  });

  it('still parses a normal single-scope title identically (type + scope)', () => {
    expect(parse('fix(diff): classify a thing')).toEqual({ type: 'fix', scope: 'diff' });
  });

  it('still parses a no-scope title (scope stays undefined, subject may hold parens)', () => {
    expect(parse('feat: add a thing (#123)').type).toBe('feat');
    expect(parse('feat: add a thing (#123)').scope).toBeUndefined();
  });

  it('still parses the release bot chore(release): commit', () => {
    expect(parse('chore(release): 0.12.73 [skip ci]')).toEqual({
      type: 'chore',
      scope: 'release',
    });
  });

  it('does not match a non-conventional header (no type/colon)', () => {
    expect(parse('just some words without a colon type').type).toBeUndefined();
  });
});

#!/usr/bin/env node
// Enforce that a PR title carries a SINGLE conventional-commit type with an OPTIONAL SINGLE
// scope — e.g. `fix(revert): …`, `feat: …`, `chore(release): …`.
//
// The `amannn/action-semantic-pull-request` gate only checks that the LEADING type is allowed;
// it accepts a COMPOUND title like `fix(read)+fix(revert): …`. But a compound title:
//   1. failed to RELEASE entirely — semantic-release's `.releaserc.json` headerPattern scope
//      class `[^)]+` cannot span the `)` that sits mid-header, so the commit parsed as no type
//      and semantic-release logged "no release" (PR #1431/#1446 shipped to main unpublished);
//      #1448 made the parser tolerant, but…
//   2. still renders an UGLY CHANGELOG scope (`read)+fix(revert`).
// So reject compound / malformed titles at the PR gate: pick ONE type and put the rest in the
// scope / subject. Keep the type list in sync with `.github/workflows/pr-title-check.yml`.
export const PR_TITLE_TYPES = [
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
];

// A single type, an optional single scope with NO nested `)`, an optional breaking `!`, then
// `: ` and a non-empty subject. A compound `fix(read)+fix(revert): …` fails because `: ` does
// not immediately follow the first `(scope)`.
const PR_TITLE_RE = new RegExp(`^(?:${PR_TITLE_TYPES.join('|')})(?:\\([^)]+\\))?!?: .+`);

export function isValidPrTitle(title) {
  return PR_TITLE_RE.test(title);
}

// CLI: `node scripts/check-pr-title.mjs "<title>"` → exit 0 if valid, 1 (with a GitHub
// ::error:: annotation) otherwise. Guarded so importing the module for tests never runs it.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const title = process.argv[2] ?? '';
  if (!isValidPrTitle(title)) {
    console.error(
      `::error::PR title must be a SINGLE conventional-commit type with an optional single scope, ` +
        `e.g. 'fix(revert): …'. Compound titles like 'fix(read)+fix(revert): …' are not allowed — ` +
        `pick one type and put the detail in the scope/subject. Got: ${title}`
    );
    process.exit(1);
  }
}

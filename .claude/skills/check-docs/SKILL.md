---
name: check-docs
description: Check if documentation (README.md, DESIGN.md, docs/) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

Check whether `README.md`, `DESIGN.md` and `docs/` are up to date with the code.
Run it ONCE PER PR, at the FINAL sha — most internal refactors change nothing
the docs describe, so an early run only has to be repeated.

## Steps

1. **Identify what changed**: on a `wt-*` branch, diff against the base to see
   everything this PR changes, committed or not:
   `git diff --name-only "$(git merge-base origin/main HEAD)"`. On `main`, fall
   back to `git diff HEAD~5 --name-only`.

2. **Decide whether a deep review is needed (short-circuit)**. A deep review is
   required if the diff touches ANY of:
   - `src/cli.ts` — the `HELP` text and command/flag surface, documented
     verbatim in README.md "Commands & options" and "Quick start".
   - `src/cli-args.ts` — flag parsing (flag names, defaults, exit codes).
   - `src/revert/writers.ts` — `SDK_WRITERS` is the set of types cdkrd can
     actually revert. README.md "Known limitations" makes claims about what is
     / is not revertable; a change to `SDK_WRITERS` keys can make a "not
     revertable" claim stale (or vice versa).
   - `src/read/router.ts` / `src/read/overrides.ts` — the CC-API vs
     SDK-override read routing, documented in README.md "CC-gap types read via
     SDK overrides".
   - **any new file added** under `src/**` — confirm it doesn't contradict the
     architecture described in DESIGN.md.
   - `package.json` — dependency additions/removals (README.md "Develop" /
     "Install" mention the toolchain).
   - `README.md`, `DESIGN.md`, `docs/**` — the docs themselves.

   If none apply (only internal src files, no new files, no deps changed),
   write a one-line note — "no docs-visible surface touched" — and stop. Do NOT
   re-read docs for unrelated internal edits.

3. **When a deep review is warranted**, map changed source to docs:
   - `src/cli.ts` (HELP) / `src/cli-args.ts` → README.md "Commands & options",
     "Quick start", exit codes. Confirm every command (`check` / `accept` /
     `revert`) and flag in the source `HELP` string appears in README.md, and
     that README.md lists no flag the source no longer parses.
   - `src/revert/writers.ts` (`SDK_WRITERS`) → README.md "Known limitations":
     confirm the revertable / non-revertable claims match the actual map keys.
   - `src/read/**` → README.md "CC-gap types read via SDK overrides" and the
     low-noise normalization section.
   - New files / architecture changes → DESIGN.md.
   - `package.json` dependency changes → README.md "Develop".

4. **Read the relevant doc sections** and compare with the actual code to find:
   - Stale flag names / removed flags still documented (or new flags
     undocumented).
   - Stale "not revertable" (or "revertable") claims vs `SDK_WRITERS`.
   - Command lists in README.md that don't match `src/cli.ts`.
   - Outdated descriptions that no longer match the code.

5. **Report findings** as a checklist: each discrepancy with file + section + a
   suggested fix. If none found, confirm documentation is consistent.

6. **Fix the issues** (or ask for confirmation first).

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files).
- Focus on consistency between existing docs and code, not completeness.
- Prefer referencing source (e.g. "see `SDK_WRITERS`") over hardcoded lists that
  drift.

---
name: check-docs
description: Check if documentation (README.md, DESIGN.md, docs/) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

You are checking whether documentation is up to date with recent code changes in
cdk-real-drift (cdkrd). The `docs` markgate gate is scoped to `src/**`,
`docs/**`, `README.md`, and `DESIGN.md` (see `.markgate.yml`), so any src edit
invalidates the marker — but most internal refactors don't affect anything the
docs describe.

## Steps

1. **Identify what changed**: Run `git diff HEAD~5 --name-only` (solo repo, no PR
   base) to see recently changed files.

2. **Decide whether a deep review is needed (short-circuit)**. Skip the LLM-judged
   review and set the marker directly when the diff **only** touches files the
   docs don't describe. A deep review is required if the diff touches ANY of:
   - `src/cli.ts` — the `HELP` text and command/flag surface documented verbatim
     in README.md "Commands & options" and "Quick start".
   - `src/cli-args.ts` — flag parsing (flag names, defaults, exit codes).
   - `src/revert/writers.ts` — `SDK_WRITERS` is the set of types cdkrd can
     actually revert. README.md "Known limitations" makes claims about what is /
     is not revertable; a change to `SDK_WRITERS` keys can make a "not
     revertable" claim stale (or vice versa).
   - `src/read/router.ts` / `src/read/overrides.ts` — the CC-API vs SDK-override
     read routing, documented in README.md "CC-gap types read via SDK overrides".
   - **any new file added** under `src/**` — confirm it doesn't contradict the
     architecture described in DESIGN.md.
   - `package.json` — dependency additions/removals (README.md "Develop" /
     "Install" mention the toolchain).
   - `README.md`, `DESIGN.md`, `docs/**` — the docs themselves.

   If none of the above apply (only internal src files, no new files, no deps
   changed), write a one-line note — "no docs-visible surface touched" — set the
   `docs` marker (see below), and stop. Do NOT re-read docs for unrelated
   internal edits.

3. **When a deep review is warranted**, map changed source to docs:
   - `src/cli.ts` (HELP) / `src/cli-args.ts` → README.md "Commands & options",
     "Quick start", exit codes. Confirm every command (`check` / `accept` /
     `revert`) and flag listed in the source `HELP` string appears in README.md,
     and that README.md lists no flag the source no longer parses.
   - `src/revert/writers.ts` (`SDK_WRITERS`) → README.md "Known limitations":
     confirm the revertable / non-revertable type claims match the actual
     `SDK_WRITERS` map keys.
   - `src/read/**` → README.md "CC-gap types read via SDK overrides" and the
     low-noise normalization section.
   - New files / architecture changes → DESIGN.md.
   - `package.json` dependency changes → README.md "Develop".

4. **Read the relevant doc sections** and compare with the actual code to find:
   - Stale flag names / removed flags still documented (or new flags undocumented).
   - Stale "not revertable" (or "revertable") claims vs the actual `SDK_WRITERS`.
   - Command lists in README.md that don't match `src/cli.ts`.
   - Outdated descriptions that no longer match the code.

5. **Report findings** as a checklist: each discrepancy with file + section + a
   suggested fix. If none found, confirm documentation is consistent.

6. **Fix the issues** (or ask for confirmation first).

## Commit-gate marker (on success only)

After documentation is verified consistent (no issues found, or all fixed),
record the `docs` marker so the markgate `docs` gate is satisfied. Run from the
repo root (use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set docs
```

Skip this step if issues remain unfixed — a stale or missing marker correctly
forces re-running `/check-docs` after fixing docs.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files).
- Focus on consistency between existing docs and code, not completeness.
- Prefer referencing source (e.g. "see `SDK_WRITERS`") over hardcoded lists that
  drift.

<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — the whole point. An unclaimed lane races a
  parallel agent onto the same central table.
- **A fresh issue is someone's deferral, not free backlog** (§3-a). The author field
  proves nothing about which session filed it, so the 60-minute window is the whole
  defence — and §4 is its other half: claim what you FILE, not only what you take.
- **One lane per central table.** `noise.ts` / `classify.ts` / `revert/plan.ts`
  each absorb most fixes; you cannot parallelize two issues that both land there.
- **A collision-driven local fallback beats touching a contested file.** If your
  fix needs a value that lives in a table another agent owns (e.g. a `KNOWN_DEFAULTS`
  default while fixing revert), add a small SELF-CONTAINED local table in YOUR file
  rather than editing theirs (this session: `REVERT_SET_DEFAULT_VALUES` in
  `revert/plan.ts` sourced a `false` default without touching `noise.ts`).
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff main` appears to have removed; rebase instead.
- **`delstack`, not `cdk destroy`** — plain deletion orphans blocking members. And
  a real deploy account may hold PROD stacks — unique names only.
- **`vp pack` before any `vp test run` / live-test in a fresh worktree** — with no
  `dist/`, 13 CLI-spawning tests fail on a clean `main` (measured 2026-08-19,
  go-to-k/cdk-real-drift#1768). The stale-cache worry that used to sit here is
  handled in `vite.config.ts`: `build` is `cache: false`, and `check` / `test`
  report a cache
  MISS on every run.
- **Earn the `verify-pr` marker via `/verify-pr`, never hand-set it.** A `src/**` PR
  merge needs a fresh `verify-pr` marker, but `mise exec -- markgate set verify-pr`
  from a shell is rejected by BOTH the `verify-pr-gate` PreToolUse hook AND the
  auto-mode Bash classifier (which flags "self-merging a src PR on a hand-set marker
  that skipped the live-test"). Run `/verify-pr <PR#>` — it does the checklist and is
  the ONLY legitimate setter. If the classifier still blocks the self-merge, that is
  the reviewer guardrail: get the maintainer's explicit authorization (or let them
  merge) rather than working around it.
- **`gh pr merge --delete-branch` from a worktree errors yet still merges.** Run from
  a worktree while `main` is checked out in the main tree, it exits 1 with
  `fatal: 'main' is already used by worktree …` — but the REMOTE merge AND remote
  branch delete already SUCCEEDED (gh only failed the post-merge local `checkout main`
  - local branch delete). Confirm with `gh pr view <n> --json state,mergedAt`
    (`MERGED`), then do the local cleanup yourself: `git checkout main && git pull`,
    `git worktree remove …`, `git branch -D wt-…` (the `git push origin --delete` will
    report "remote ref does not exist" — benign, gh already removed it).

- **An IN-PLACE run ends with the Stop hook still calling its lane unmerged, and
  the remedy that warning names is one this mode forbids.**
  `.claude/hooks/stop-unmerged-lane-warn.sh` lists every worktree whose branch is
  ahead of `origin/main`, and this repo SQUASH-merges, so a merged branch reads
  as ahead forever; its own text then says the remaining work is to remove the
  worktree and delete the branch, which SKILL.md "Launch mode" forbids for the
  tree you are standing in. Expected, not a defect: confirm the PR is MERGED
  (`gh pr view <n> --json state,mergedAt`) and say so in the wrap. The only way
  to clear it from inside is to leave the branch —
  `git -C "<LANE_TREE>" switch --detach origin/main`, since the hook skips a
  worktree with no current branch and `main` itself is checked out in the main
  checkout. **Never write that BARE.** As of
  go-to-k/cdk-real-drift#1845 a bare `git switch --detach` run after a cwd reset
  is REFUSED by `.claude/hooks/main-tree-branch-gate.sh` rather than silently
  detaching the SHARED main checkout — its `switch` arm treats `--detach` as a
  block, since detaching moves the shared tree off `main` exactly as a branch
  switch does. That converts a silent clobber into a loud refusal; it does not
  make the bare spelling correct. The `-C` is what makes the command target the
  tree you MEAN, and a refusal still leaves the lane's detach undone. Whether to detach at all belongs to whoever owns the workspace, not
  to this run — except in §10-d, where THIS run creates the retro branch in this
  tree and therefore owns that one branch move.

## Important existing rules this skill leans on

- **Core invariant**: a clean, un-mutated deploy has ZERO `[Potential Drift]` on
  first `check`. A value the user never changed surfacing is a fold gap = the bug —
  never rationalize it as "honest". (`CLAUDE.md` → Core invariant + Fold-strategy
  decision order.)
- **English-only** for all committed/public artifacts (source, docs, PR/commit
  messages, and every issue this flow writes on this repo — §4's claim comments AND
  the bodies it files).
- **Always add unit tests** for a fix — do not wait to be asked.
- **All changes via PR; never commit to `main`.** Develop in a git worktree with
  DISJOINT files — a new one per lane, or the worktree this run was launched in
  when the mode is IN-PLACE (SKILL.md "Launch mode"); the orchestrator
  integrates. (`CLAUDE.md` → Workflow Rules.)
- **Never download/run/install untrusted third-party content** (§0).
- **Wrap with a Remaining-work section + Session-close verdict, scoped to the
  issues this run actually worked.** This skill is the easiest place to get that
  scope wrong: it starts from a backlog, so the issues you triaged but did NOT
  pick up look like follow-ups. They are not. List only residuals of the lanes
  you shipped (gaps, deferred polish, issues filed because of this work).
  (`CLAUDE.md` → Workflow Rules.)

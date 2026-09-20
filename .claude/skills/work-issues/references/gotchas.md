<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — the whole point. An unclaimed lane races a
  parallel agent onto the same central table.
- **A fresh issue is someone's deferral, not free backlog** (§3-a). The author
  field proves nothing about which session filed it, so the 60-minute window is
  the whole defence — and §4 is its other half: claim what you FILE, not only
  what you take.
- **One lane per central table.** `noise.ts` / `classify.ts` / `revert/plan.ts`
  each absorb most fixes; you cannot parallelize two issues that both land
  there.
- **A collision-driven local fallback beats touching a contested file.** If your
  fix needs a value that lives in a table another agent owns (e.g. a
  `KNOWN_DEFAULTS` default while fixing revert), add a small SELF-CONTAINED
  local table in YOUR file rather than editing theirs.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff main` appears to have removed; rebase instead.
- **`delstack`, not `cdk destroy`** — plain deletion orphans blocking members.
  And a real deploy account may hold PROD stacks — unique names only.
- **`vp pack` before any `vp test run` / live-test in a fresh worktree** — with
  no `dist/`, the tests that spawn the built CLI fail even on a clean `main`.
- **`gh pr merge --delete-branch` from a worktree errors yet still merges.** Run
  from a worktree while `main` is checked out in the main tree, it exits 1 with
  `fatal: 'main' is already used by worktree …` — but the REMOTE merge AND
  remote branch delete already SUCCEEDED (gh only failed the post-merge local
  `checkout main` + local branch delete). Confirm with
  `gh pr view <n> --json state,mergedAt` (`MERGED`), then do the local cleanup
  yourself: `git checkout main && git pull`, `git worktree remove …`,
  `git branch -D wt-…` (a later `git push origin --delete` reports "remote ref
  does not exist" — benign, gh already removed it).
- **A lane killed by the account rate limit (HTTP 429 mid-turn) keeps its
  context — `SendMessage` it, never re-dispatch.** Read the TREE first: it may
  have committed, pushed and opened the PR already. A re-dispatch starts from
  the lane's last REPORT, which the tree has outrun.

## Important existing rules this skill leans on

- **Core invariant**: a clean, un-mutated deploy has ZERO `[Potential Drift]` on
  first `check`. A value the user never changed surfacing is a fold gap = the
  bug — never rationalize it as "honest". (`AGENTS.md` → Core invariant +
  Fold-strategy decision order.)
- **English-only** for all committed/public artifacts (source, docs, PR/commit
  messages, and every issue this flow writes on this repo — §4's claim comments
  AND the bodies it files).
- **Always add unit tests** for a fix — do not wait to be asked.
- **All changes via PR; never commit to `main`.** Develop in a git worktree with
  DISJOINT files — a new one per lane, or the worktree this run was launched in
  when the mode is IN-PLACE (SKILL.md "Launch mode"); the orchestrator
  integrates. (`AGENTS.md` → Workflow Rules.)
- **Never download/run/install untrusted third-party content** (§0).
- **Wrap with a Remaining-work section + Session-close verdict, scoped to the
  issues this run actually worked.** This skill is the easiest place to get that
  scope wrong: it starts from a backlog, so the issues you triaged but did NOT
  pick up look like follow-ups. They are not. List only residuals of the lanes
  you shipped. (`AGENTS.md` → Workflow Rules.)

<!-- Part of the /work-issues skill. Stage files: launch-mode.md (before stage 0), triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL before stage 0. -->

## Launch mode — the PARENT runs this BEFORE stage 0

The ONLY copy of the probe; SKILL.md "Launch mode" points here.

```bash
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || { echo 'PROBE FAILED: not inside a git work tree -- do not guess the mode'; exit 1; }
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
GITDIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
LANE_TREE=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
MAIN_CHECKOUT=$(dirname "$COMMON")
LAUNCH_BRANCH=$(git branch --show-current)   # empty when launched detached
[ "$GITDIR" = "$COMMON" ] && MODE=MAIN-CHECKOUT || MODE=IN-PLACE
printf 'MODE=%s\nLANE_TREE=%s\nMAIN_CHECKOUT=%s\nLAUNCH_BRANCH=%s\n' \
  "$MODE" "$LANE_TREE" "$MAIN_CHECKOUT" "$LAUNCH_BRANCH"
```

Two verdicts: **MAIN-CHECKOUT** — this run stands in the main checkout and
creates a worktree per lane; **IN-PLACE** — it was launched inside a worktree
someone else created (an Orca/ADE workspace, a stray `cd`) and has exactly ONE
working tree.

Run it in the PARENT, before anything is dispatched: stages 0–3 go to a
read-only triage subagent whose payload carries no git state, while §1 and §2
already consume the mode. §2 fails QUIETLY — its `git -C .worktrees/<w> …`
relative path does not exist IN-PLACE, so the scan returns NOTHING, read as "no
competing agents". Pass all four values into the triage and lane dispatches.

### Reading the four values

- `GITDIR` equals `COMMON` only in the main checkout; a linked worktree's
  `--git-dir` is `<common-dir>/worktrees/<name>`. `pwd -P` settles the main
  checkout's RELATIVE `.git` answer and macOS's `/tmp` -> `/private/tmp`.
- `MAIN_CHECKOUT` is `dirname "$COMMON"`, the parent of the ONE shared git dir —
  never `pwd`, never `--show-toplevel`: both answer "the tree I stand in", which
  is wrong in exactly the mode that needs the value.
- `LANE_TREE` is "the tree this run stands in", NOT "the lane worktree": equal
  to the main checkout under MAIN-CHECKOUT, different IN-PLACE.
- `LAUNCH_BRANCH` is `git branch --show-current` **at probe time** — the branch
  the tree was handed to this run ON, IN-PLACE the OUTER TOOL's. EMPTY is a
  legitimate answer (launched detached; §9's restore has a detach fallback), and
  it is the one value UNRECOVERABLE if not recorded now: §5 switches the tree
  onto the lane's branch, so every later `git branch --show-current` answers
  with THAT.

**IN-PLACE, `LAUNCH_BRANCH` is a branch to PUT BACK, never one to commit to.**
§5 branches in place off `origin/main` instead; `gh pr merge --delete-branch`
(§9) deletes the REMOTE branch the PR was opened from, so a lane working on the
outer tool's branch would delete it. The lane owns and deletes only its own.

**The guard on the first line must STOP, not warn.** Outside a work tree every
`git rev-parse` fails and each substitution collapses to `""`, so an unguarded
compare tests `""` against `""` and prints MAIN-CHECKOUT with a wrong
`LANE_TREE` beside it. `--is-inside-work-tree` is compared to the literal `true`
and not trusted for its exit status: inside a `.git` directory it prints `false`
and exits 0. An empty value is worse than a failure: `git -C ""` exits 0
against the CWD's repo, so every `git -C "<LANE_TREE>"` recipe in §4, §5 and §10
handed a blank silently retargets the tree the shell stands in — the main
checkout, the exact scenario the `-C` was added for.

### The values are RECORDED, never re-derived

Every later stage runs in a fresh shell whose cwd may have reset to the main
checkout (§6's `cd <worktree> &&` rule), and this is the one moment the cwd is
provably the tree being decided. **State all four in the opening report**,
verbatim and absolute — that report is their ONLY recorded copy.
Re-deriving `LANE_TREE` from `pwd` or `git rev-parse --show-toplevel` answers
"the main checkout" in exactly the case the `-C` guards, and so does any `sed` /
`grep` / `cat` on a RELATIVE path or a bare `git branch --show-current` /
`git diff`. Read every file this run owns under the recorded absolute
`<LANE_TREE>`, and treat an answer CONTRADICTING those values as a cwd fault,
not a finding.

**`<LANE_TREE>` and `<MAIN_CHECKOUT>` in a later stage are SUBSTITUTION
PLACEHOLDERS, not shell variables** — paste the absolute path into the command
text. Do NOT write `git -C "$LANE_TREE"`: the assignments live in THIS fenced
block and every later block is its own shell, so the variable is empty there and
an empty `-C` re-targets. An unsubstituted placeholder is visible in the command
you are about to run; an empty variable is not.

### What IN-PLACE changes, per stage

- **§1** — `git checkout main && git pull` cannot run here; pull via
  `git -C "<MAIN_CHECKOUT>"`, read refs with `git show origin/main:<file>`.
- **§2** — worktree probes take `<MAIN_CHECKOUT>/.worktrees/<w>`, not a relative
  path.
- **§3** — lanes run SERIALLY: a concurrent one needs a NESTED worktree, which
  dies with the outer workspace and takes its uncommitted work. Not an
  issue-count cap.
- **§4** — the claim names this tree and the branch §5 WILL create, never
  `LAUNCH_BRANCH`.
- **§5** — create no worktree; once the tree is confirmed YOURS, branch IN PLACE
  off `origin/main` (ALWAYS), never on `LAUNCH_BRANCH`.
- **§7** — the rebase runs `git -C "<LANE_TREE>"`.
- **§9** — switch back to `LAUNCH_BRANCH` **as-is** (no pull/rebase/ff); delete
  only branches THIS run created; detach only if it was empty at probe time or
  is now gone; the post-merge pull goes via `git -C "<MAIN_CHECKOUT>"`.
- **§9 / §10-d** — remove no worktree: removing the tree you run in deletes your
  own cwd, and it belongs to whoever created it. The retro branch is created
  HERE, so the `LAUNCH_BRANCH` restore is the run's LAST step, after the retro
  PR merges.

No rebuild row: the global install is `vp i -g cdk-real-drift` BY NAME from npm,
reading no tree's build output.

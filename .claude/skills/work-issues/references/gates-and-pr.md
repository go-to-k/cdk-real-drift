<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration
is not execution — every PreToolUse gate here was once registered yet INERT for
a day (go-to-k/cdk-real-drift#1801), an ungated commit looks exactly like one
that passed, and `/hooks` shows registration only. One command does:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call — hooks see only the agent's tool calls, so a
human-typed line proves nothing. `--dry-run` commits nothing whatever the tree
looks like. Expected: `Blocked by branch-gate` or `Blocked by check-gate`.
**Git's own output instead (`On branch main`, `nothing to commit`) means the
gates are not firing** — then run each gate's check by hand and say so in the
report.

From inside the worktree — no `dist/` there yet, and 13 tests spawn the built
CLI, so `vp pack` runs before the suite:

```bash
vp run typecheck && vp check --fix && vp pack && vp test run
```

All green, then commit (conventional-commit), push, and open the PR with
`Closes #<n>`.

**Set the `check` / `docs` markers in their OWN Bash call, from the WORKTREE,
and after staging.** Three traps, all hit in one lane (2026-08-19,
go-to-k/cdk-real-drift#1782):

- **A gated command must be the ONLY thing in its Bash call.** A PreToolUse
  hook judges the call BEFORE anything runs, and a denial discards every
  PREAMBLE SIDE EFFECT: `markgate set check && markgate set docs && git commit`
  is blocked in FULL — including the `markgate set` that would have satisfied
  it — and a denied `gh pr create --body-file` dropped its chained heredoc
  write, so the retry's `>>` created the body as a fragment
  (go-to-k/cdk-local#525 opened with no summary or `Closes` line). **Worse is a
  STALE body file from an EARLIER session** — conventional paths
  (`/tmp/pr-body.md`) are shared, so the gate reports violations this session
  never wrote (2026-08-21, cdkd): check the file's mtime first, and use
  per-session body-file names. Gated commands: `git commit` (`check-gate`,
  `branch-gate`, `bughunt-clean-gate`), `git push` (`branch-gate`,
  `stale-base-gate`), `gh pr create` / `gh pr edit` / `gh pr merge`
  (`verify-pr-gate`, `ci-green-gate`, `non-english-text-gate`). Body file in
  its own call, markers in theirs, gated command alone.
- **Run `markgate set` from the worktree, starting the call with
  `cd <worktree> &&` EXPLICITLY** — the shell cwd does not reliably persist
  across tool calls, so a wrong-cwd set is the DEFAULT outcome. The marker
  store is PER-WORKTREE — `<git rev-parse --absolute-git-dir>/markgate/`, which
  is `.git/markgate` only for the MAIN checkout and
  `.git/worktrees/<name>/markgate/` for a lane — so a marker set from the main
  checkout is not merely hashed over the wrong files, it is INVISIBLE from the
  lane (`no marker`). It fails CLOSED either way: a wasted cycle, not a bad
  merge. `/check` / `/check-docs`'s "repo root" means the WORKTREE root here,
  and `/check` carries the three-tree measurement. (This paragraph asserted
  "SHARED across worktrees" until the 2026-09-03 re-measurement on markgate
  0.4.1 — three trees of this ONE repo answered `markgate status check` three
  ways — and the correction is the lesson: a false premise reaching a true
  conclusion produces no failing command. The siblings' `pr-review` sha
  sentinel does not apply here — that gate is INERT, `.markgate.yml`.) After
  any TIMEOUT or REFUSED call, `pwd` and re-verify what the aborted call was to
  create: either can reset the cwd or leave a directory uncreated, a failed
  `cd` stops an `&&` chain but NOT the later lines of a multi-line call
  (2026-08-28, go-to-k/cdkd#2370), and a relative `cd .worktrees/...` fails
  SILENTLY when the cwd is already inside that worktree.
- **`cd <worktree> &&` on a GATED command is safe only while the hook
  conditions match it**, and twice they did not: three gates lacked the `cd`
  spelling — `cd <wt> && git commit` ran UNGATED
  (go-to-k/cdk-real-drift#1786) — then the fix joined spellings with `or`, an
  unsupported expression matching NOTHING; all eight gates inert for a day
  (go-to-k/cdk-real-drift#1801). **An `if` carries ONE pattern; a gate guarding
  two verbs gets two ENTRIES**, written UNANCHORED (`Bash(*git commit*)`)
  because the matcher only hands the script candidates — the script re-matches
  precisely. Fenced by `tests/gate-if-matchers-1801.test.ts` (fails on an `or`,
  an anchored verb pattern, a gate missing an entry). After any change to how a
  gate is selected, watch it go RED once, by hand.
- Stage new files first. A marker set while your new test is still untracked
  does not cover it.

## 7. If main advanced while you worked (parallel merges)

A peer's merges move `main` (and, when the release PR merges, a
`chore(release)` commit); `git diff main..<branch>` then shows **phantom
removals** of the peer's added lines — a stale-base artifact, NOT real
deletions. Confirm the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-run gates, `git push --force-with-lease`.

**A rebase CONFLICT on your target file is usually a DUPLICATE, not a merge to
resolve.** The claim comment does NOT beat a peer who STARTED earlier, so even
a file-disjoint lane can be raced. Before resolving anything, check whether the
work already shipped:

```bash
gh issue view <n> --json state,stateReason                     # CLOSED/COMPLETED → already fixed
git log origin/main --oneline | grep -iE "<n>|<fix-keyword>"   # the peer's merged PR
git show origin/main:<your-target-file> | grep -n "<marker>"   # main already carries the fix?
```

**A CLEAN merge is not evidence that there was no collision.** Two lanes
editing the SAME file merge without conflict when they touch disjoint SECTIONS,
so §3's one-lane-per-file rule fails SILENTLY (go-to-k/cdk-real-drift#1772 /
go-to-k/cdk-real-drift#1773 rewrote the same SKILL.md minutes apart; both
survived by luck). After a merge into a file another PR touched in the same
window, `git pull` and grep `main` for a marker string from EACH side. Three
things make that check misreport, and all three read as LOST CONTENT:

- **Source each marker from the MERGED text, never from a draft you read
  earlier** — lanes reword between draft and merge, so a draft-sourced marker
  scores 0 and looks like a clobber (go-to-k/cdkd#2000). Take THEIR marker from
  THEIR merge commit:
  `git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`.
- **One arm of the check is always tautological.** The LAST-merged lane's
  marker reads back out of the tip for free; the load-bearing arm is the
  EARLIER-merged lane's.
- **Use `grep -cF`, keep the marker on ONE LINE of the merged file, and do not
  chain the two greps with `&&`.** Regex metacharacters score 0 without `-F`,
  and `grep` is LINE-based while these files are hard-wrapped, so a verbatim
  phrase spanning the wrap scores 0 too (both measured here 2026-08-19; the
  wrap column moves with the wording, so a sibling's marker for the same rule
  does not wrap the same here). `grep -c` exits 1 on zero matches — the very
  case being hunted — so a chained second grep never runs. Pick the phrase from
  the merged file itself; settle a 0 with
  `git show origin/main:<file> | grep -n "<one short word>"`, which prints the
  whole line and where it breaks. (Double quotes, not `-F`, are what survive an
  apostrophe.) When a marker genuinely comes back 0, settle it from your lane
  worktree with `diff <(git show origin/main:<file>) <file>`: the lines YOUR
  commit removed should be exactly the ones you meant to replace.

**And the two lanes need not touch one file at all: a peer that adds a
REPO-WIDE check gains jurisdiction over YOUR content.** The collision is their
TEST against your CONTENT — neither CI exercised the pair. When a peer merges,
look at WHAT it added, not only which files: anything that globs the tree
(`git ls-files`, a `readdirSync`, a lint rule) applies to everything you are
about to land. Rebase and RUN it over your own diff before merging
(go-to-k/cdk-real-drift#1782 into go-to-k/cdk-real-drift#1783: the check cost
one command).

If the issue is CLOSED (or main already carries an equivalent fix), **ABANDON
the lane — do NOT resolve the conflict to re-apply a now-duplicate fix**:
`git rebase --abort`, `gh pr close <pr> --delete-branch` (or never open one),
comment the collision on the issue, `git worktree remove`. The merge-time twin
of §1's already-shipped check, at the expensive place (it fired here after a
full lane was done — go-to-k/cdk-real-drift#726 / go-to-k/cdk-real-drift#742).
The claim comment cannot eliminate races; the conflict is your last,
authoritative signal to stop and check before spending more.

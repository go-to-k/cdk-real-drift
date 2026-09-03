<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration is
not execution — every PreToolUse gate here was once registered yet INERT for a day
(go-to-k/cdk-real-drift#1801), and an ungated commit looks exactly like one that
passed; `/hooks` shows registration only. One command does:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call — hooks see only the agent's tool calls, so a
human-typed line proves nothing. `--dry-run` commits nothing
whatever the tree looks like. Expected: `Blocked by branch-gate` or `Blocked by
check-gate`. **Git's own output instead (`On branch main`, `nothing to commit`)
means the gates are not firing** — then run each gate's check by hand and say so
in the report.

From inside the worktree — no `dist/` there yet, and 13 tests spawn the built
CLI, so `vp pack` runs before the suite:

```bash
vp run typecheck && vp check --fix && vp pack && vp test run
```

All green, then commit (conventional-commit), push, and open the PR with
`Closes #<n>`.

**Set the `check` / `docs` markers in their OWN Bash call, from the WORKTREE, and
after staging.** Three traps, all hit in one lane (2026-08-19,
go-to-k/cdk-real-drift#1782):

- **A gated command must be the ONLY thing in its Bash call.** A PreToolUse hook
  judges the call BEFORE anything runs: `markgate set check && markgate set docs
&& git commit` is blocked in FULL — including the `markgate set` that would
  have satisfied it — and a denial discards every PREAMBLE SIDE EFFECT: a denied
  `gh pr create --body-file` dropped its chained heredoc write and the retry's
  `>>` created the body as a fragment — go-to-k/cdk-local#525 opened with no
  summary or `Closes` line, go-to-k/cdk-local#509 closed by hand. **Worse is a
  STALE body file from an EARLIER session** — conventional paths
  (`/tmp/pr-body.md`) are shared, so the gate reports violations this session
  never wrote (2026-08-21, cdkd): check the file's mtime first, and use
  per-session body-file names. Gated commands: `git commit` (`check-gate`,
  `branch-gate`, `bughunt-clean-gate`), `git push` (`branch-gate`,
  `stale-base-gate`), `gh pr create` / `gh pr edit` / `gh pr merge`
  (`verify-pr-gate`, `ci-green-gate`, `non-english-text-gate`). Body file in its
  own call, markers in theirs, gated command alone.
- Run `markgate set` from the **worktree**, starting the call with
  `cd <worktree> &&` EXPLICITLY — the shell cwd does not reliably persist across
  tool calls, so a wrong-cwd set is the DEFAULT outcome. A KILLED (timeout) or
  REFUSED call is a named trigger: either can reset the cwd or leave an expected
  directory uncreated, and a failed `cd` stops an `&&` chain but NOT the later
  lines of a multi-line call, which write into whatever cwd was current
  (2026-08-28, go-to-k/cdkd#2370); a relative `cd .worktrees/...` also fails when
  the cwd is ALREADY inside that worktree — no timeout, no refusal, and the
  chained edit silently does not run — after any timeout or refusal, `pwd` and
  re-verify what the aborted call was to create. The marker store is
  PER-WORKTREE — `<git rev-parse --absolute-git-dir>/markgate/`, which is
  `.git/markgate` only for the MAIN checkout and `.git/worktrees/<name>/markgate/`
  for a lane — so a marker set from the main checkout is not merely hashed over
  the wrong files, it is INVISIBLE from the lane, which reports `no marker`. It
  fails CLOSED either way: a wasted cycle, not a bad merge. `/check` /
  `/check-docs`'s "repo root" means the WORKTREE root here, and `/check` carries
  the three-tree measurement.
  **This paragraph asserted the opposite until 2026-09-03 and the correction is
  the lesson**: it called the store `.git/markgate`, SHARED by every worktree,
  and told the reader that the sibling repo reaches the same symptom by a
  DIFFERENT mechanism — "import the advice, not its explanation". Re-measured on
  markgate 0.4.1 (the `.mise.toml` pin), three trees of this ONE repo answer
  `markgate status check` three ways: main `mismatch` rc=1 (created
  2026-07-21T13:17:24Z), an existing lane `match` rc=0 (created
  2026-08-29T19:42:42Z), a freshly-added worktree `no marker` rc=1 with no store
  on disk. The mechanism is the SAME as the sibling's, and the sentence telling
  the reader to discard the explanation was protecting the wrong half. The
  ADVICE — set markers from the worktree — never changed, which is exactly why
  nothing caught it: a false premise reaching a true conclusion produces no
  failing command. markgate state is the WHOLE of the per-worktree question
  here: the siblings additionally bind `pr-review` to a `.markgate-pr-review-sha`
  sentinel, and that gate is INERT in this repo (no companion skill, no hook —
  `.markgate.yml`) with no such file on disk, so none of its behaviour applies
  to a cdkrd lane.
- `cd <worktree> &&` on a GATED command is safe only while the hook conditions
  match it, and twice they did not: go-to-k/cdk-real-drift#1786 (three gates
  lacked the `cd` spelling — `cd <wt> && git commit` ran UNGATED), then
  go-to-k/cdk-real-drift#1801 (the fix joined spellings with `or`, an
  unsupported expression — an `if` holding `A or B` matches NOTHING; all eight
  gates inert for a day). **An `if` carries ONE pattern; a gate guarding two
  verbs gets two ENTRIES**, written UNANCHORED (`Bash(*git commit*)`) because
  the matcher only hands the script candidates — the script re-matches
  precisely. Fenced by `tests/gate-if-matchers-1801.test.ts` (fails on an `or`,
  on an anchored verb pattern, and on a gate missing an entry). After any change
  to how a gate is selected, watch it go RED once, by hand.
- Stage new files first. A marker set while your new test is still untracked does
  not cover it.

## 7. If main advanced while you worked (parallel merges)

A peer's merges move `main` (and, when the release PR merges, a
`chore(release)` commit); `git diff main..<branch>`
then shows **phantom removals** of the peer's added lines — a stale-base
artifact, NOT real deletions. Confirm the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-run gates, `git push --force-with-lease`.

**A rebase CONFLICT on your target file is usually a DUPLICATE, not a merge to
resolve.** The claim comment does NOT beat a peer who STARTED earlier, so even a
file-disjoint lane can be raced. Before resolving anything, check whether the
work already shipped:

```bash
gh issue view <n> --json state,stateReason                     # CLOSED/COMPLETED → already fixed
git log origin/main --oneline | grep -iE "<n>|<fix-keyword>"   # the peer's merged PR
git show origin/main:<your-target-file> | grep -n "<marker>"   # main already carries the fix?
```

**A CLEAN merge is not evidence that there was no collision.** Two lanes editing
the SAME file merge without conflict when they touch disjoint SECTIONS, so §3's
one-lane-per-file rule fails SILENTLY (go-to-k/cdk-real-drift#1772 /
go-to-k/cdk-real-drift#1773 rewrote the same SKILL.md minutes apart; both
survived by luck). After a merge into a file another PR touched in the same
window, `git pull` and grep `main` for a marker string from EACH side.

Three things make that check misreport, and all three read as LOST CONTENT:

- **Source each marker from the MERGED text, never from a draft you read
  earlier.** Lanes reword between draft and merge, so a draft-sourced marker
  scores 0 and looks like a clobber (go-to-k/cdkd#2000). Take THEIR marker from
  THEIR merge commit:
  `git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`.
- **One arm of the check is always tautological.** The LAST-merged lane's marker
  reads back out of the tip for free; the load-bearing arm is the
  EARLIER-merged lane's.
- **Use `grep -cF`, keep the marker on ONE LINE of the merged file, and do not
  chain the two greps with `&&`.** Regex metacharacters make a bare `grep -c`
  score 0 (measured here 2026-08-19: a marker containing `[` and `.` scored 0
  without `-F` and 1 with it), and `grep` is LINE-based while these files are
  hard-wrapped, so a verbatim phrase spanning the wrap scores 0 too (measured
  2026-08-19 against go-to-k/cdk-real-drift#1790's merge commit). Pick the phrase from
  the merged file itself — the wrap column moves with the wording, so
  go-to-k/cdk-local#532's marker for this same rule does not wrap the same here.
  Settle a 0 with `git show origin/main:<file> | grep -n "<one short word>"`,
  which prints the whole line and where it breaks. `grep -c` exits 1 on zero
  matches — the very case being hunted — so a chained second grep never runs.
  (Double quotes, not `-F`, are what survive an apostrophe.)

When a marker genuinely comes back 0, settle it from your lane worktree with
`diff <(git show origin/main:<file>) <file>`: the lines YOUR commit removed
should be exactly the ones you meant to replace.

**And the two lanes need not touch one file at all: a peer that adds a REPO-WIDE
check gains jurisdiction over YOUR content.** The collision is their TEST against
your CONTENT — neither CI exercised the pair (yours ran before their check
existed, theirs before your content did). When a peer merges, look at WHAT it
added, not only which files: anything that globs the tree (`git ls-files`, a
`readdirSync`, a lint rule) applies to everything you are about to land. Rebase
and RUN it over your own diff before merging (go-to-k/cdk-real-drift#1782 into
go-to-k/cdk-real-drift#1783: the check cost one command).

If the issue is CLOSED (or main already carries an equivalent fix), **ABANDON the
lane — do NOT resolve the conflict to re-apply a now-duplicate fix**: `git rebase
--abort`, `gh pr close <pr> --delete-branch` (or never open one), comment the
collision on the issue, `git worktree remove`. The merge-time twin of §1's
already-shipped check, at the expensive place: on go-to-k/cdk-real-drift#726 and
go-to-k/cdk-real-drift#742 it fired here after a full lane was done. The claim
comment cannot eliminate races; the conflict is your last, authoritative signal
to stop and check before spending more.

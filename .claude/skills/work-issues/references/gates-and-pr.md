<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration is
not execution: on 2026-08-20 every PreToolUse gate in this repo was registered and
INERT for a day (go-to-k/cdk-real-drift#1801 — an `if` holding `A or B` matches
nothing), and the failure is silent in the worst direction, because an ungated
commit looks exactly like one that passed. `/hooks` shows what is REGISTERED, so
it cannot see this. One command does:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call. PreToolUse hooks gate the agent's tool calls
and nothing else — the identical line typed by a human into a terminal bypasses
the hook system entirely, so it always looks "unblocked" and proves nothing. That
mistake was made while writing this rule.

`--dry-run` commits nothing whatever the tree looks like. Expected: `Blocked by
branch-gate` (the root is on `main`) or `Blocked by check-gate` (markers stale).
**Git's own output instead — `On branch main`, `nothing to commit` — means the
gates are not firing at all**, and everything below is then self-enforced: run
each gate's own check by hand and say so in the report, because nothing else will.

From inside the worktree — a fresh worktree has no `dist/`, and 13 tests fail
without it (they spawn the built CLI), so `vp pack` runs before the suite:

```bash
vp run typecheck && vp check --fix && vp pack && vp test run
```

All green, then commit (conventional-commit), push, and open the PR with
`Closes #<n>`.

**Set the `check` / `docs` markers in their OWN Bash call, from the WORKTREE, and
after staging.** Three separate traps, all hit in one lane on 2026-08-19
(go-to-k/cdk-real-drift#1782):

- **A gated command must be the ONLY thing in its Bash call.** `check-gate` is a
  **PreToolUse** hook, so it judges the call BEFORE anything in it runs: a single
  call of `markgate set check && markgate set docs && git commit` is blocked in
  FULL — including the `markgate set` that would have satisfied it — and the message
  says "run /check first" when you just did. The trap is not confined to markers,
  because a denial also discards every PREAMBLE SIDE EFFECT you assumed had already
  happened. On 2026-08-19 in the sibling repo a heredoc body-file write chained onto
  `gh pr create --body-file` was denied by its verify-pr gate, so the body file was
  never written; the retry appended with `>>`, which CREATED the file as a fragment,
  and go-to-k/cdk-local#525 opened carrying only its review section — no summary and
  no `Closes` line. That silently cost the auto-close: its body had to be patched
  after the merge and go-to-k/cdk-local#509 closed by hand. **The worse
  signature is not that ABSENT file but a STALE one from an EARLIER session**,
  since these paths are conventional (`/tmp/pr-body.md`) and shared: the gate
  then inspects that file and reports violations from content this session never
  wrote. Measured 2026-08-21 in cdkd, where a `gh pr create` whose heredoc had
  not run was refused for four bare `#N` refs belonging to a lane days old, none
  of them in the draft on screen. If a gate names text you do not recognise,
  check the file's mtime before hunting for the text, and give body files a
  per-session name. Every gated command here
  is reachable the same way — `git commit` (`check-gate`, `branch-gate`,
  `bughunt-clean-gate`), `git push` (`branch-gate`, `stale-base-gate`), and
  `gh pr create` / `gh pr edit` / `gh pr merge` (`verify-pr-gate`, `ci-green-gate`,
  `non-english-text-gate`). Write the body file in its own call, set markers in
  theirs, then submit the gated command alone.
- Run `markgate set` from the **worktree**, not the main checkout — and say so
  EXPLICITLY, starting the call with `cd <worktree> &&` rather than relying on a
  `cd` from an earlier call. The shell cwd does not reliably persist across tool
  calls, which makes the wrong-cwd set the DEFAULT outcome rather than a slip; it
  fired again while this very lane was written, when a relative `cd .worktrees/…`
  failed because the cwd was ALREADY inside that worktree and the chained edit
  silently did not run. The marker store is `.git/markgate`, which every worktree
  SHARES, but the hashes are taken from the cwd's files — so setting from the main
  checkout records `main`'s content. Measured 2026-08-19: with the worktree dirty
  and the marker set from the main checkout, a `markgate verify check` returns rc=1
  from the worktree and rc=0 from main — it fails CLOSED, so it costs a wasted cycle
  rather than a bad merge. But `/check` and `/check-docs` both say "run from the
  repo root", which in this flow's mandated worktree means the WORKTREE root. The
  sibling repo shows the same symptom from a DIFFERENT mechanism (its stores are
  per-worktree, so the marker reads as missing rather than wrong) — import the
  advice, not its explanation.
- That `cd <worktree> &&` form is safe on a GATED command only because the hook
  conditions match it, and twice they did not. On go-to-k/cdk-real-drift#1786 three
  gates lacked the `cd` alternative, so `cd <wt> && git commit` ran UNGATED. The fix
  added the missing spellings joined with `or` — and on
  go-to-k/cdk-real-drift#1801 that join turned out **not to be a supported
  expression**: an `if` holding `A or B` matches NOTHING, so for a day ALL EIGHT
  gates were inert. `git commit` on `main` with no markers reached git in two
  different clients while `branch-gate.sh` run by hand on the same payload blocked
  with exit 2. Proved with three throwaway hooks: an `if`-less one fired,
  `if: "Bash(git status*)"` fired, the `or` one never did. **An `if` carries ONE
  pattern; a gate guarding two verbs gets two ENTRIES**, and the pattern is written
  UNANCHORED (`Bash(*git commit*)`) because the matcher's only job is to hand the
  script every candidate — the script re-matches precisely. cdkd, whose gates have
  always fired, carries no `if` at all for exactly this reason.
  `tests/gate-if-matchers-1801.test.ts` now fails on an `or`, on an anchored verb
  pattern, and on a gate missing an entry for a command it guards. The bypass in
  both incidents was silent: an ungated command looks exactly like one that passed,
  which is why a gate is worth watching go RED once, by hand, after any change to
  how it is selected.
- Stage new files first. A marker set while your new test is still untracked does not
  cover it.

## 7. If main advanced while you worked (parallel merges)

A peer agent merging its PRs moves `main` (+ a `chore(release)` bump). Your branch
is now behind and `git diff main..<branch>` shows **phantom removals** of the
peer's added lines — that is the stale-base artifact, NOT real deletions. Confirm
the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C .worktrees/<name> rebase origin/main                        # clean if disjoint
```

Re-run gates, `git push --force-with-lease`.

**A rebase CONFLICT on your target file is usually a DUPLICATE, not a merge to
resolve.** The claim comment does NOT beat a peer who STARTED earlier, so even a
peripheral, file-disjoint, offline lane can be raced — when your lane's file
conflicts on rebase (or `gh pr merge` reports "merge conflicts"), a peer most
likely landed the SAME fix in parallel. Before resolving anything, check whether
the work already shipped:

```bash
gh issue view <n> --json state,stateReason                     # CLOSED/COMPLETED → already fixed
git log origin/main --oneline | grep -iE "<n>|<fix-keyword>"   # the peer's merged PR
git show origin/main:<your-target-file> | grep -n "<marker>"   # main already carries the fix?
```

**A CLEAN merge is not evidence that there was no collision.** Two lanes editing
the SAME file merge without a conflict whenever they touch disjoint SECTIONS of it,
so §3's one-lane-per-file rule fails SILENTLY rather than loudly —
go-to-k/cdk-real-drift#1772 and go-to-k/cdk-real-drift#1773 both rewrote
`.claude/skills/work-issues/SKILL.md` within minutes of each other on
2026-08-19 and both landed intact, which was luck, not design. After a merge that
lands into a file another PR touched in the same window, `git pull` and grep `main`
for a marker string from EACH side before believing both survived.

Three things make that check misreport, and all three read as LOST CONTENT:

- **Source each marker from the MERGED text, never from a draft you read earlier.**
  A lane routinely rewords a sentence between the draft you saw and the commit it
  merges, so a draft-sourced marker returns 0 and looks like a clobber. Take THEIR
  marker out of THEIR merge commit —
  `git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`. In
  cdkd on 2026-08-19 a bullet drafted as "A mirror issue can duplicate an open PR"
  merged as "A mirror issue is a duplicate more often than it looks"
  (go-to-k/cdkd#2000): nothing was lost, the marker was stale.
- **One arm of the check is always tautological.** Whichever lane merged LAST has
  its marker read back out of what is now the tip, so two hits are one confirmation
  plus one freebie. The load-bearing arm is the EARLIER-merged lane's — if you only
  have budget to think about one, think about that one.
- **Use `grep -cF`, keep the marker on ONE LINE of the merged file, and do not
  chain the two greps with `&&`.** Prose markers are full of regex metacharacters,
  so an unanchored `grep -c` silently fails to match and produces exactly the false
  alarm this check exists to prevent — measured here 2026-08-19: a marker
  containing `[` and `.` scored 0 without `-F` and 1 with it. `grep` is LINE-based
  while these files are hard-wrapped, so a perfectly verbatim phrase that spans the
  wrap scores 0 the same way: measured here 2026-08-19 against
  go-to-k/cdk-real-drift#1790's merge commit, `Two lanes editing the SAME file`
  scored 0 / rc=1 while the very next words on one line,
  `the SAME file merge without a conflict`, scored 1 / rc=0. Pick the phrase from
  the merged file you are about to grep rather than reusing a sibling repo's —
  the wrap column moves with the wording, so go-to-k/cdk-local#532's marker for
  this same rule is not the phrase that wraps here — and settle a 0 with
  `git show origin/main:<file> | grep -n "<one short word of it>"`, which prints
  the whole line and shows where it breaks. `grep -c` also exits 1 on zero matches,
  which is the very case being hunted, so a chained second grep never runs. (Double
  quotes, not `-F`, are what survive an apostrophe.)

When a marker genuinely does come back 0, settle it from your lane worktree with
`diff <(git show origin/main:<file>) <file>`: the lines YOUR commit removed should
be exactly the ones you meant to replace.

**And the two lanes need not touch one file at all: a peer that adds a REPO-WIDE
check gains jurisdiction over YOUR content.** File-disjointness says nothing here,
because the collision is their TEST against your CONTENT, and neither PR's CI
necessarily exercised the pair — yours ran before their check existed, theirs ran
before your content did. So when a peer merges, look at WHAT it added, not only at
which files it touched: a test that globs the tree (`git ls-files`, a `readdirSync`
over a directory, a lint rule) applies to everything you are about to land. Rebase
and RUN it over your own diff before merging. Measured here 2026-08-19
(go-to-k/cdk-real-drift#1782 into go-to-k/cdk-real-drift#1783): the first added a
scanner over every committed `.md` while the second was adding ~100 lines of new
markdown to a file the first never touched. Rebasing and running that scanner scored
21/21, so nothing broke — but the check cost one command, and the gate that would
have caught a failure only existed once the two were combined.

If the issue is CLOSED (or main already carries an equivalent fix), **ABANDON the
lane — do NOT resolve the conflict to re-apply a now-duplicate fix**: `git rebase
--abort`, `gh pr close <pr> --delete-branch` (or never open one), comment the
collision on the issue, `git worktree remove`. This is the merge-time twin of
§1's already-shipped check, and the expensive place to run it: on both
go-to-k/cdk-real-drift#726 and go-to-k/cdk-real-drift#742 it fired here, after a
full lane (implement + test + live-verify) was already done. The claim
comment reduces collisions but cannot eliminate them; the rebase/merge conflict is
your last, authoritative signal to stop and check before spending more.

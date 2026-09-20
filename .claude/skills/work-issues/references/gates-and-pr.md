<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Checks + PR (per lane)

Two mechanical conditions block a merge, and the first is the SERVER's: the
`main` ruleset requires `ci-ok`, `check` and `English-only (PR title / body)`
with zero bypass actors, so GitHub refuses the merge while any of them is red or
pending. It also requires a PULL REQUEST for any change to `main` and allows
only a SQUASH merge, so `git push origin main` is refused whatever its checks
say. (Enumerated once, in `.claude/rules/hooks.md`; what the server still cannot
see is a commit on your LOCAL `main`.) The second condition is local: a **clean
bug-hunt sentinel**
(`bughunt-clean-gate`, which also gates `git commit`; the ship stage covers
releasing it). `stale-base-gate` additionally refuses a push that would revert
work already on `main` — the one thing the server cannot see. Everything else here is procedure you run because it is right, not
because something stops you.

**No liveness probe proves the local hooks are alive any more.** The one that
did — `git commit --dry-run` tripping `branch-gate` — went with that hook, and
every surviving gate needs an armed sentinel, a dirty main checkout or a
clobbering push before it refuses anything — so a `/hunt-bugs` run, which arms
the sentinel, is the one context that gives a free signal. Otherwise treat them
as SELF-ENFORCED unless you have watched one fire this session, and say which in
the report. `git push --dry-run` proves nothing about the ruleset either.

From inside the worktree — no `dist/` there yet, and the tests that spawn the
built CLI fail without it, so `vp pack` runs before the suite:

```bash
vp run typecheck && vp check --fix && vp pack && vp test run
```

All green, then run `/check` and `/check-docs`, commit (conventional-commit),
push, and open the PR with `Closes #<n>`.

**A gated command must be the ONLY thing in its Bash call.** A PreToolUse hook
judges the call BEFORE anything runs, so a denial discards every PREAMBLE SIDE
EFFECT: a denied `gh pr create --body-file` dropped its chained heredoc write,
and the retry's `>>` left the body a fragment with no `Closes` line. Worse is a
STALE body file from an EARLIER session — conventional paths
(`/tmp/pr-body.md`) are shared, so check mtime and use per-session names.

**Prefix a worktree call with `cd <worktree> &&` EXPLICITLY**, since the cwd
does not reliably persist across tool calls, and after any TIMEOUT or REFUSED
call `pwd` before trusting the next one: a failed `cd` stops an `&&` chain but
NOT the later lines of a multi-line call, and a relative `cd .worktrees/...`
fails SILENTLY when the cwd is already inside that worktree.

**When you edit how a hook is SELECTED, watch it go RED once, by hand** — a
registered hook can still be inert. **An `if` carries ONE pattern, so a hook
guarding two verbs gets two ENTRIES**, written UNANCHORED (`Bash(*git commit*)`)
because the matcher only hands the script candidates and the script re-matches
precisely; joining two spellings with `or` is unsupported and matches NOTHING.
Fenced by `tests/gate-if-matchers-1801.test.ts`.

## 7. If main advanced while you worked (parallel merges)

A peer's merges move `main`, so `git diff main..<branch>` shows **phantom
removals** of the peer's added lines — a stale-base artifact, NOT real
deletions. Confirm the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-run the checks, then `git push --force-with-lease`.

**A rebase CONFLICT on your target file is usually a DUPLICATE, not a merge to
resolve** — the claim comment does not beat a peer who STARTED earlier. Before
resolving anything, check whether the work already shipped:

```bash
gh issue view <n> --json state,stateReason                     # CLOSED/COMPLETED → already fixed
git log origin/main --oneline | grep -iE "<n>|<fix-keyword>"   # the peer's merged PR
git show origin/main:<your-target-file> | grep -n "<marker>"   # main already carries the fix?
```

If so, **ABANDON the lane — do NOT resolve the conflict to re-apply a
now-duplicate fix**: `git rebase --abort`, `gh pr close <pr> --delete-branch`
(or never open one), comment the collision on the issue, `git worktree remove`.

**A CLEAN merge is not evidence that there was no collision**: two lanes editing
the SAME file merge without conflict when they touch disjoint SECTIONS, so §3's
one-lane-per-file rule fails SILENTLY. After a merge into a file another PR
touched in the same window, `git pull` and grep `main` for a marker from EACH
side. Three things make that check misreport, all reading as LOST CONTENT:

- **Source each marker from the MERGED text, never from a draft you read
  earlier** — lanes reword between draft and merge, so a draft-sourced marker
  scores 0 and looks like a clobber. Take THEIR marker from THEIR merge commit:
  `git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`.
- **One arm of the check is always tautological**: the LAST-merged lane's marker
  reads back out of the tip for free, so the load-bearing arm is the
  EARLIER-merged lane's.
- **Use `grep -cF`, keep the marker on ONE LINE of the merged file, and do not
  chain the two greps with `&&`.** Regex metacharacters score 0 without `-F`;
  `grep` is LINE-based while these files are hard-wrapped, so a phrase spanning
  the wrap scores 0 too; and `grep -c` exits 1 on zero matches — the very case
  being hunted — so a chained second grep never runs. Settle a 0 with
  `git show origin/main:<file> | grep -n "<one short word>"`, which prints the
  whole line and where it breaks, then with
  `diff <(git show origin/main:<file>) <file>` from your lane worktree: the
  lines YOUR commit removed should be exactly the ones you meant to replace.

**And the two lanes need not touch one file at all: a peer that adds a
REPO-WIDE check gains jurisdiction over YOUR content**, and neither CI run
exercised the pair. When a peer merges, look at WHAT it added, not only which
files — anything that globs the tree (`git ls-files`, a `readdirSync`, a lint
rule) applies to everything you are about to land, so rebase and RUN it over
your own diff before merging.

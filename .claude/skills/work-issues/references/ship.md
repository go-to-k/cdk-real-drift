<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → cleanup

With subagent lanes, this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane agent (SendMessage) to
run its owed §8 live test + `/sweep-resources` and merge while it holds the
turn, or run them yourself FROM THAT LANE'S WORKTREE. The worktree matters
mechanically: gate verdicts are computed against the tree the command runs from
— the markgate store is PER-WORKTREE (§6 carries the 2026-09-03 re-measurement)
and the bughunt-clean gate keys the committing WORKTREE owner — so a marker set
from the main tree is invisible to the lane, and a merge issued from there
attests to MAIN's content (cdkd measured the merge-time failure live:
go-to-k/cdkd#2363). Live-AWS runs have a second, repo-specific reason to stay
inside the granted turn: the deploy-autoarm sentinel is per-SESSION, and a lane
subagent's calls carry this same session, so one lane's deploy arms the token
that blocks EVERY lane's commit / PR create / merge until `/sweep-resources`
clears it. Never two lanes' live tests or merges concurrently; everything after
the merge (pull → cleanup) stays with the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the reply
every time.** `Resuming agent ...` means the stopped agent was RESTARTED to
receive it; `Message queued for delivery ...` delivers only if something ELSE
resumes the agent — and a lane that ended its turn on "merge-ready" is stopped
by definition, so the turn-grant lands in a queue nothing will drain. Measured
2026-09-02 (go-to-k/cdkd#2417): a lane sat idle ~5 minutes that way; an
immediate re-send answered `Resuming agent` and unstuck it. After any send: if
the answer was "queued", confirm the agent actually runs (its next completion
notification) or re-send at once. A queued message is never a granted turn.

```bash
gh pr merge <n> --squash --delete-branch     # squash is the repo's only method
```

(Local branch delete fails while its worktree exists — expected; the worktree
removal below clears it.) Merge each verified PR. If a later PR is behind,
GitHub still merges it when the files are disjoint — but if the PR that landed
first added a repo-wide check, rebase and run it over your diff first (§7).

**When one lane fixes a full-suite flake, merge THAT lane first.** Every other
lane's §6 gate run and `/verify-pr` roll the same dice until the fix is on
`main`, and the REBASE is what delivers it. Standing instance: the
`json-empty-on-error` suite flakes even with `dist/` packed (§8). Measured cost
of skipping: go-to-k/cdk-local#509 hit the go-to-k/cdk-local#515 timeout 2/2
while the fix sat unmerged in a parallel lane; the first run after merging
go-to-k/cdk-local#522 and rebasing was green (2026-08-19).

**A PR's CI runs on the MERGE ref, not on your branch** — `pull_request`
triggers test your branch combined with current `main`, so a red check can be
caused by a PEER's just-merged content your local green never saw (and it also
blocks `ci-green-gate`). Fix: fetch + rebase + re-run; do NOT start distrusting
the peer's new test (2026-08-19, go-to-k/cdk-local#524 failed CI on a line
go-to-k/cdk-local#520 had merged in parallel). Same cause as §7's
repo-wide-check collision; the same rebase answers both.

**Before you watch CI, poll until checks EXIST.** `gh pr checks <n> --watch`
does NOT cover that wait: with none reported it returns AT ONCE rather than
blocking for them to appear, so an `until` loop wrapping it hot-spins through a
whole tool timeout. Nor does the JSON form answer with an empty array —
`--json name,state` prints ZERO bytes and exits 1 with `no checks reported` on
stderr (measured, gh 2.89.0), so a poll reading a length reads nothing. Poll for
a ROW, from a backgrounded loop, then `--watch` once one exists:

```bash
until gh pr checks <n> -R <owner>/<repo> --json name,state 2>/dev/null \
  | grep -q '"name"'; do sleep 20; done
```

And the wait is YOURS to keep: `ci-green-gate` FAILS OPEN on that state
(`CLAUDE.md` → "State of the Repo" records it; cdkd's blocks, and cdk-local
carries no such gate at all), so nothing stops a merge issued before CI has
registered.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the
main tree, so a `checkout main` here fails with "already used by worktree ..."
(the same failure §1's pull hits and the appendix records for
`gh pr merge --delete-branch`; a MAIN-CHECKOUT run has a tree to return to, an
IN-PLACE run does not). Never leave your own tree; pull the main checkout
through `-C`, substituting the absolute `<MAIN_CHECKOUT>` the launch-mode probe
printed and the opening report recorded. That spelling fixes two defects of the
`MAIN=$(git worktree list …)` form this block used to carry: it does not depend
on the main checkout being row 1 of the listing, and it cannot be EMPTY — an
empty `$MAIN` is the dangerous half, since `git -C "" pull origin main` exits 0
and pulls `origin/main` into whatever tree the shell is standing in, which
IN-PLACE is this lane's branch. A never-substituted placeholder is visible in
the command; an empty variable is not:

```bash
git -C "<MAIN_CHECKOUT>" pull origin main
```

**Release** is BATCHED (`CLAUDE.md` → "State of the Repo" owns the rules: an
ordinary merge publishes nothing by itself, and the standing release PR is
never yours to merge). This stage owes only the confirmation that it picked
your merge up:

```bash
gh pr list --state open --search "chore(release) in:title"   # the standing release PR
```

Only after a release PR merge does the published npm package move; the
**global install by NAME** then refreshes it:

```bash
vp i -g cdk-real-drift
```

That install is BY NAME from npm, so it is mode-independent — it never reads
any tree's build output. (The sibling cdkd links its global CLI at the main
checkout's `dist/`, forcing a post-merge rebuild there; nothing in this repo's
ship stage does. Do not add one.) After an ORDINARY merge the installed binary
is already the latest published version — skip the install rather than polling
for a bump that is never coming, and say so in the wrap; a run whose lanes are
all `chore:` / `docs:` does not even move the release PR (2026-08-19,
go-to-k/cdk-real-drift#1767 merged as `chore:` and this text still sent the run
polling).

**Remove every worktree you created** (a left-behind worktree is the silent
residue of this flow).

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git worktree remove .worktrees/<name>        # --force if it refuses on artifacts
git worktree prune
git worktree list                            # yours should be gone
```

IN-PLACE — run THIS block INSTEAD, never both. **An IN-PLACE run created no
worktree, so it removes none**: it must not `git worktree remove` the tree it
is running in (that deletes its own cwd). Cleanup of the TREE belongs to
whoever created it — the outer tool, or the operator — so the wrap SAYS so
instead of doing it. What the run DOES owe is the BRANCH: put back the one it
found, delete the one it made. `<LAUNCH_BRANCH>` and `<lane branch>` are
SUBSTITUTION PLACEHOLDERS taken from the opening report, not shell variables
(`references/launch-mode.md` — a fresh Bash call is a fresh shell, and an empty
`git switch ""` is not the failure you want):

```bash
git switch <LAUNCH_BRANCH>     # AS-IS: no pull, no rebase, no fast-forward
git branch -D <lane branch>    # -D, not -d (squash) - see the merge above
git branch --show-current      # must print <LAUNCH_BRANCH>
git status --porcelain         # must be empty: the tree is as you found it
```

Fallback, and ONLY when `LAUNCH_BRANCH` was empty at probe time (the run was
launched detached) or the branch is now gone — never as the default:

```bash
git fetch origin && git switch --detach origin/main
git branch -D <lane branch>
```

**Three end states, and only one of them is quiet.** Staying on the lane branch
leaves a squash-merged tip the unmerged-lane Stop hook warns about on EVERY
turn (its tip is never an ancestor of `main` — the same squash artifact that
forces `-D` above). Detaching silences that but is VISIBLE-SURPRISING in the
outer tool's UI, which created the workspace ON a branch — the maintainer
flagged it live (go-to-k/cdk-real-drift#1854). `LAUNCH_BRANCH` restored is
both: 0 commits ahead of `origin/main`, so the Stop hook stays silent AND the
workspace looks untouched.

**AS-IS is the whole rule: RESTORE, never ADJUST.** The first draft
fast-forwarded `LAUNCH_BRANCH` to `origin/main` on the way back; that clause is
WITHDRAWN. The tree and the branch are the outer tool's artifacts and this
run's job is to leave them exactly as found — "it was only a fast-forward" is
precisely the reasoning that produced the detached HEAD this rule replaces. If
the branch is behind, that is the tool's business.

**This step runs LAST, not per-lane.** §10 takes its retro branch in this same
tree, so restoring here and branching again in §10-d would just undo itself:
IN-PLACE, do the merge in §9 and come back for the restore once the retro PR
has merged. `--delete-branch` on each merge still removes the REMOTE branches,
which is fine and independent of any of this.

**Only the ones YOU created.** A worktree you did not create is a peer lane,
and `git worktree list` cannot tell whose it is — a finished run's leftover and
a live session look identical. The closing check is "every worktree I added is
gone", never "only the main checkout remains" — which an IN-PLACE run satisfies
by having added none. **Every ownership signal establishes LIFE, never
absence**: a dirty tree or an open PR proves a lane is live; the absence of
either proves nothing. A tip on `main` is not death (the owner may be in
ship/retro steps), and a claim comment carries CLAIM time, not last activity.
Measured both "finished" signals failing at once (2026-08-19):
`.worktrees/vp-bump-1780` sat on `main`'s own tip with zero open PRs, yet
merged go-to-k/cdk-real-drift#1787 twenty minutes later; a "residue" worktree
merged go-to-k/cdk-real-drift#1773 the same day while the removing lane was
still open. So `git log --oneline -1` and
`gh pr list --state all --head <branch>` can find a reason to LEAVE a worktree,
never license removing one. When in doubt leave it and say so in the wrap.

Finally, comment the outcome on each issue if it was not auto-closed.
**RELEASE the claim on every issue that did NOT auto-close.** `--delete-branch`
has just deleted the branch your claim names, so what is left is a lock
pointing at nothing: the next session reads "Working on this in branch <gone>"
and either skips a free issue or has to prove you are finished. Derive the
population mechanically — every issue this run CLAIMED, minus the ones now
CLOSED:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` in that list needs a release comment — they are exactly the
partially-closed ones (a `Closes #N` PR auto-closes; a lane that shipped part
of an umbrella said `Refs` on purpose, which auto-closes nothing), the same
ones a future session is most likely to pick up. Say three things, because a
bare "released" makes the next session re-derive what you already know: the
issue is now UNCLAIMED, what the merged PR actually closed, and what remains
WITH the reason it was left. Carry forward anything expensive the lane measured
(a live arm, a derived population, a family of bugs), so the next lane inherits
the evidence rather than the diagnosis. A claim on an issue that DID auto-close
needs nothing: a closed issue is not a lock.

Do NOT stop here: what the run taught you is still only in this session's
context, so go on to §10 — which also decides WHERE each lesson belongs (memory
is the weakest of the options there, not the default one).

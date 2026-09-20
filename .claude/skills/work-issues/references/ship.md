<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → cleanup

With subagent lanes this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane (SendMessage) to run its
owed §8 live test plus `/sweep-resources` and merge while it holds the turn, or
run them yourself FROM THAT LANE'S WORKTREE, since the bughunt-clean gate keys
the COMMITTING worktree's owner. Live-AWS runs must stay inside the granted turn
for a second reason: the deploy-autoarm sentinel is per-SESSION, so one lane's
deploy blocks EVERY lane's commit / PR create / merge until `/sweep-resources`
clears it. Never two lanes' live tests or merges concurrently; everything after
the merge stays with the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the reply
every time.** `Resuming agent ...` means the stopped agent was RESTARTED to
receive it; `Message queued for delivery ...` delivers only if something ELSE
resumes it, and a lane that ended its turn on "merge-ready" is stopped by
definition, so the turn-grant lands in a queue nothing will drain. On "queued",
confirm the agent runs (its next completion notification) or re-send at once.

```bash
gh pr merge <n> --squash --delete-branch     # squash is the repo's only method
```

Merge each verified PR; a local branch delete fails while its worktree exists,
which the cleanup below clears. A later PR that is behind still merges when the
files are disjoint — but if the PR that landed first added a repo-wide check,
rebase and run it over your diff first (§7). **When one lane fixes a full-suite
flake, merge THAT lane first**: every other lane's §6 run and `/verify-pr` roll
the same dice until the fix is on `main`, and the REBASE delivers it (standing
instance: `json-empty-on-error` flakes even with `dist/` packed, §8).

**A PR's CI runs on the MERGE ref, not on your branch**, so a red check can come
from a PEER's just-merged content your local green never saw, and the ruleset
then refuses the merge. Fetch, rebase, re-run; do not distrust the peer's new
test.

**Before you watch CI, poll until checks EXIST.** `gh pr checks <n> --watch`
does NOT cover that wait: with none reported it returns AT ONCE rather than
blocking, so an `until` loop wrapping it hot-spins through a whole tool timeout.
Nor does the JSON form answer with an empty array — `--json name,state` prints
ZERO bytes and exits 1 with `no checks reported` on stderr, so a poll reading a
length reads nothing. Poll for a ROW, from a backgrounded loop, then `--watch`
once one exists:

```bash
until gh pr checks <n> -R <owner>/<repo> --json name,state 2>/dev/null \
  | grep -q '"name"'; do sleep 20; done
```

The wait is YOURS to keep, and the server does not keep it for you: a required
check that has not REGISTERED yet is not the same as one reporting failure, so
poll until the checks exist, then watch them.

Then bring the merges local — **run exactly ONE line**, per SKILL.md "Launch
mode". IN-PLACE cannot `checkout main` (`already used by worktree ...`), so it
pulls the main checkout through `-C` without leaving its own tree, substituting
the absolute `<MAIN_CHECKOUT>` the launch-mode probe printed. Never derive that
path from `git worktree list`: it assumes the main checkout is row 1 and can
come back EMPTY, and `git -C "" pull origin main` exits 0 while pulling into
whatever tree the shell stands in — an unsubstituted placeholder is visible, an
empty variable is not.

```bash
git checkout main && git pull origin main      # MAIN-CHECKOUT only
git -C "<MAIN_CHECKOUT>" pull origin main      # IN-PLACE instead, never both
```

**Release** is BATCHED, and its rules live in `AGENTS.md` → "State of the Repo"
(an ordinary merge publishes nothing; the standing release PR is never yours to
merge). This stage owes one check —
`gh pr list --state open --search "chore(release) in:title"` — and no
`vp i -g cdk-real-drift` after an ordinary merge, since the installed binary is
already the latest published version.

**Remove every worktree you created** (a left-behind one is this flow's silent
residue), again **running exactly ONE arm**. **An IN-PLACE run created no
worktree, so it removes none**: `git worktree remove` on the tree it runs in
deletes its own cwd, and the TREE belongs to whoever created it, so the wrap
SAYS so instead. What it owes is the BRANCH: put back the one it found, delete
the one it made. `<LAUNCH_BRANCH>` and `<lane branch>` are SUBSTITUTION
PLACEHOLDERS from the opening report, not shell variables — a fresh Bash call is
a fresh shell, and an empty `git switch ""` is not the failure you want.

```bash
# MAIN-CHECKOUT only:
git worktree remove .worktrees/<name>   # --force if it refuses on artifacts
git worktree prune && git worktree list # yours should be gone
# IN-PLACE instead, never both:
git switch <LAUNCH_BRANCH>     # AS-IS: no pull, no rebase, no fast-forward
git branch -D <lane branch>    # -D, not -d (squash) - see the merge above
git branch --show-current      # must print <LAUNCH_BRANCH>
git status --porcelain         # must be empty: the tree is as you found it
```

Fall back to `git fetch origin && git switch --detach origin/main` plus the same
`branch -D` ONLY when `LAUNCH_BRANCH` was empty at probe time (launched
detached) or the branch is gone.

**AS-IS is the whole rule: RESTORE, never ADJUST.** Staying on the lane branch
leaves a squash-merged tip that is never an ancestor of `main` (the artifact
forcing `-D` above); detaching is visible-surprising in the outer tool's UI,
which created the workspace ON a branch; `LAUNCH_BRANCH` restored is 0 commits
ahead of `origin/main` and looks untouched. Do not fast-forward it on the way
back — a branch left behind is the outer tool's business.

**This cleanup runs LAST, not per-lane**: §10 takes its retro branch in this
same tree, so restoring here and branching again in §10-d would undo itself.
IN-PLACE, merge in §9 and restore once the retro PR has merged.

**Only the ones YOU created.** `git worktree list` cannot tell whose a worktree
is, so the closing check is "every worktree I added is gone", never "only the
main checkout remains". **Every ownership signal establishes LIFE, never
absence**: a dirty tree or an open PR proves a lane is live, the absence of
either proves nothing — a tip on `main` is not death (the owner may be in
ship/retro steps), and a claim comment carries CLAIM time, not last activity.
When in doubt leave it and say so in the wrap.

Finally, **RELEASE the claim on every issue that did NOT auto-close.**
`--delete-branch` has just deleted the branch your claim names, leaving a lock
pointing at nothing: the next session reads "Working on this in branch <gone>"
and either skips a free issue or has to prove you are finished. Derive the
population mechanically — every issue this run CLAIMED, minus the ones now
CLOSED (`gh issue view <n> --json state -q .state`); each `OPEN` one is a
partially-closed issue, since `Closes #N` auto-closes while the `Refs` a lane
used for part of an umbrella does not, and a claim on a closed issue needs
nothing. Say three things, since a bare "released" makes the next session
re-derive what you know: the issue is UNCLAIMED, what the merged PR closed, and
what remains WITH the reason. Carry forward anything expensive the lane measured
(a live arm, a derived population, a family of bugs) so the next lane inherits
the evidence, not the diagnosis.

Do NOT stop here: what the run taught you is still only in this session's
context, so go on to §10.

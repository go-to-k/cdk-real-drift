<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → release → global install → cleanup

With subagent lanes, this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane agent (SendMessage) to
run its owed §8 live test + `/sweep-resources` and merge while it holds the
turn, or run them yourself FROM THAT LANE'S WORKTREE. The worktree matters
mechanically, not stylistically: gate verdicts are computed against the tree
the command runs from — this repo's markgate store is shared across worktrees
but the HASHES come from the cwd's files (the `/check` skill's 2026-08-19
measurement), and the bughunt-clean gate keys the committing WORKTREE owner —
so a marker set or a merge issued from the main tree attests to MAIN's
content, not the lane's. cdkd measured the merge-time failure live on
2026-08-28 (go-to-k/cdkd#2363 records the cwd-race side of it).
Live-AWS runs have a second, repo-specific reason to stay inside the granted
turn: the deploy-autoarm sentinel is per-SESSION, and a lane subagent's calls
carry this same session, so one lane's deploy arms the token that blocks EVERY
lane's commit / PR create / merge until `/sweep-resources` clears it. Never
two lanes' live tests or merges concurrently; everything after the merge in
this section (pull → release → install → cleanup) stays with the parent.

```bash
gh pr merge <n> --squash --delete-branch     # squash is the repo's only method
```

(Local branch delete fails while its worktree exists — expected; the worktree
removal below clears it.) Merge each verified PR. If a later PR is behind, GitHub
still merges it when the files are disjoint — but disjoint files are not the whole
test: if the PR that landed first added a repo-wide check, rebase and run it over
your diff first (§7).

**When one lane fixes a full-suite flake, merge THAT lane first.** Every other
lane's §6 gate run and `/verify-pr` execute the same suite, so until the fix is on
`main` each rolls the same dice — and the REBASE is what delivers it (a lane
branched before the merge keeps flaking on its stale base). Standing instance:
the `json-empty-on-error` suite flakes even with `dist/` packed (§8), so a lane
fixing it outranks the ship order. Measured cost of skipping: the
go-to-k/cdk-local#509 lane hit the go-to-k/cdk-local#515 timeout 2/2 while the
fix sat unmerged in a parallel lane; the first run after merging
go-to-k/cdk-local#522 and rebasing was green (2026-08-19).

**A PR's CI runs on the MERGE ref, not on your branch** — `.github/workflows/ci.yml`
triggers on `pull_request`, so GitHub tests your branch combined with current
`main`. A red check can be caused by a PEER's just-merged content your local
green never saw, and that red also blocks `ci-green-gate` on `gh pr merge`. Fix:
fetch + rebase + re-run; do NOT start distrusting the peer's new test
(2026-08-19, go-to-k/cdk-local#524 failed CI on a line go-to-k/cdk-local#520 had
merged in parallel). Same cause as §7's repo-wide-check collision; the same
rebase answers both.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so a `checkout main` here fails with "already used by worktree ...". Never
leave your own tree; pull the main checkout through `-C`. `MAIN` is derived HERE
rather than borrowed from a neighbouring block — each fenced block is its own
Bash call and its own shell, so a variable assigned in another one is empty here:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
```

That second form is not IN-PLACE-only trivia: it is the same
`fatal: 'main' is already used by worktree ...` the appendix records for
`gh pr merge --delete-branch`. What differs is that a MAIN-CHECKOUT run has a
tree it may return to and an IN-PLACE run does not.

**Release** is automated (`.github/workflows/release.yml`) — merging a `feat:` /
`fix:` / `perf:` / `revert:` commit to `main` produces a `chore(release): <ver>
[skip ci]` bump commit on `main` a minute or two later. Poll for it before
installing:

```bash
git fetch origin && git log origin/main --oneline -3   # look for chore(release)
```

Once released, **global install by NAME** (published npm package):

```bash
vp i -g cdk-real-drift
```

That install is BY NAME from npm, so it is mode-independent: it resolves the
published package and never reads any tree's build output. (The sibling cdkd
links its global CLI at the MAIN checkout's `dist/`, which forces a post-release
rebuild there; nothing in this repo's ship stage does, so an IN-PLACE run has no
main-checkout rebuild to perform. Do not add one.)

**A run whose lanes are all `chore:` / `docs:` releases NOTHING** (CLAUDE.md → State
of the Repo): skip both steps above rather than polling — the bump is never
coming and the installed binary is already current; say so in the wrap. This is
the ordinary case for a §10 retro lane and a tooling-only backlog (2026-08-19,
go-to-k/cdk-real-drift#1767 merged as `chore:` and this text still sent the run
polling for a bump).

**Remove every worktree you created** (a left-behind worktree is the silent
residue of this flow). **An IN-PLACE run created none, so it removes none**: it
must not `git worktree remove` the tree it is running in (that deletes its own
cwd) and must not `git branch -D` the branch it is standing on. Cleanup of that
tree belongs to whoever created it — the outer tool, or the operator — so the
wrap SAYS so instead of doing it, and the run ends with the tree still standing.
`--delete-branch` on the merge still removes the REMOTE branch, which is fine;
only the local tree and its branch are off limits:

```bash
git worktree remove .worktrees/<name>        # --force if it refuses on artifacts
git worktree prune
git worktree list                            # yours should be gone
```

**Only the ones YOU created.** A worktree you did not create is a peer lane, and
`git worktree list` cannot tell you whose it is — a finished run's leftover and a
live session look identical, including a branch whose tip is already on `main`.
The closing check is "every worktree I added is gone", never "only the main
checkout remains" — which an IN-PLACE run satisfies by having added none. **Every ownership signal establishes LIFE, never absence**: a
dirty tree or an open PR proves a lane is live; the absence of either proves
nothing. A tip on `main` is not death (the owner may be in ship/retro steps), and
a claim comment carries CLAIM time, not last activity. Measured both "finished"
signals failing at once: `.worktrees/vp-bump-1780` sat on `main`'s own tip with
zero open PRs, yet merged go-to-k/cdk-real-drift#1787 twenty minutes later;
earlier the same day a "residue" worktree merged go-to-k/cdk-real-drift#1773
while the removing lane was still open (2026-08-19). So `git log --oneline -1`
and `gh pr list --state all --head <branch>` can find a reason to LEAVE a
worktree, never license removing one. When in doubt leave it and say so in the
wrap.

Finally, comment the outcome on each issue if it was not auto-closed.
**RELEASE the claim on every issue that did NOT auto-close.** `--delete-branch`
has just deleted the branch your claim names, so what is left on the issue is a
lock pointing at nothing: the next session reads "Working on this in branch
<gone>" and either skips a free issue or has to prove you are finished. Derive
the population mechanically rather than from memory -- it is every issue this
run CLAIMED, minus the ones now CLOSED:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` in that list needs a release comment. **They are exactly the
partially-closed ones** -- a `Closes #N` PR auto-closes its issue and needs
nothing, while a lane that shipped part of an umbrella said `Refs` on purpose,
which auto-closes nothing. So the issues that keep a stale claim are the same
ones a future session is most likely to pick up, which is what makes this worth
a mechanical step rather than a habit.

Say three things in the comment, because a bare "released" makes the next
session re-derive what you already know: that the issue is now UNCLAIMED, what
the merged PR actually closed, and what remains WITH the reason it was left --
an unsettled trade-off and a missing design decision read very differently to
someone deciding whether to start. Carry forward anything expensive the lane
measured (a live arm it built, a population it derived, a family of bugs it
found), so the next lane inherits the evidence rather than the diagnosis.

A claim on an issue that DID auto-close needs nothing: a closed issue is not a
lock, and commenting on it only adds noise.

Do NOT stop
here: what the run taught you is still only in this session's context, so go on to
§10 — which also decides WHERE each lesson belongs (memory is the weakest of the
options there, not the default one).

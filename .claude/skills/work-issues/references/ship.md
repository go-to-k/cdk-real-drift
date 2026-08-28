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
lane's §6 gate run and its `/verify-pr` execute the same suite, so until the fix is
on `main` each of them rolls the same dice — and the REBASE is what delivers it,
since a lane branched before the merge keeps flaking on its own stale base. This
repo has a standing instance, so the case is not hypothetical: the
`json-empty-on-error` suite flakes even with `dist/` packed (§8 — three of its 13
failed once, the identical re-run went 343/343), so a lane fixing it outranks the
rest of the ship order. The sibling measured what skipping this costs: on 2026-08-19
the go-to-k/cdk-local#509 lane hit the go-to-k/cdk-local#515 timeout 2/2 in its own
worktree while the fix sat unmerged in a parallel lane, and the first run after
merging go-to-k/cdk-local#522 and rebasing was green.

**A PR's CI runs on the MERGE ref, not on your branch** — `.github/workflows/ci.yml`
triggers on `pull_request`, so GitHub tests your branch combined with current
`main`. A red check can therefore be caused by a PEER's just-merged content that
your local green never saw, and here that red also blocks `ci-green-gate` on
`gh pr merge`. The fix is fetch + rebase + re-run; do NOT start distrusting the
peer's new test. On 2026-08-19 go-to-k/cdk-local#524's new reference harness failed
CI on a line go-to-k/cdk-local#520 had merged in parallel. This is the CI-side face
of §7's repo-wide-check collision — same cause, and the same rebase answers both.

```bash
git checkout main && git pull origin main    # bring the merges local
```

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

**A run whose lanes are all `chore:` / `docs:` releases NOTHING** (CLAUDE.md → State
of the Repo), so skip both steps above rather than polling: the bump you are waiting
for is never coming, and the installed binary is already current. Say so in the wrap
instead of reporting a release. This is the ordinary case for a §10 retro lane and
for a tooling-only backlog — on 2026-08-19 the go-to-k/cdk-real-drift#1767 lane (a
skill edit plus a test) merged as `chore:` and this text still sent the run looking
for a bump commit.

**Remove every worktree you created** (a left-behind worktree is the silent
residue of this flow):

```bash
git worktree remove .worktrees/<name>        # --force if it refuses on artifacts
git worktree prune
git worktree list                            # yours should be gone
```

**Only the ones YOU created.** A worktree you did not create is a peer lane, and
`git worktree list` cannot tell you whose it is — a leftover from a finished run
and a session working right now look identical, including a branch whose last
commit is already on `main`. On 2026-08-19 this run read
`.worktrees/work-issues-fresh-issue-quarantine-20260819` as residue of the
previous run; it was live, and it merged go-to-k/cdk-real-drift#1773 while this
lane was still open. So the closing check is "every worktree I added is gone",
never "only the main
checkout remains". Before removing one you do not recognise, know what the probes
can and cannot say: **every ownership signal establishes LIFE, never absence.** A
dirty tree or an open PR proves a lane is live; the ABSENCE of either proves
nothing at all. A branch tip already on `main` is not death — its owner may still
be inside the ship or retro steps — and a claim comment carries CLAIM time, not
last activity, so an old stamp is equally what a long-running live session looks
like. This run measured both "finished" signals failing at once: at triage
`.worktrees/vp-bump-1780` sat on `f6e0373`, which was `main`'s own tip, and
`gh pr list --state open` returned nothing — yet it was live, and it merged
go-to-k/cdk-real-drift#1787 twenty minutes later. So run `git log --oneline -1`
and `gh pr list --state all --head <branch>` to find a reason to LEAVE a worktree;
they can never license removing one. When in doubt leave it and say so in the
wrap.

Finally, comment the outcome on each issue if it was not auto-closed. Do NOT stop
here: what the run taught you is still only in this session's context, so go on to
§10 — which also decides WHERE each lesson belongs (memory is the weakest of the
options there, not the default one).

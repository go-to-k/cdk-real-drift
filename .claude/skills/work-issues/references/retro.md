<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last lane in §9 is merged and its worktree removed, BEFORE
the wrap report. This is part of the run, not an optional extra — the evidence for
it (what you had to re-read, what the text sent you into, which correction the user
had to make twice) exists only while this session's context is alive, and none of it
survives into the next `/work-issues`.

`/verify-pr` step 8 already ran a retrospective per LANE. This step has a different
subject and a wider scope, and neither is covered by that one:

- its subject is **the flow itself** — this skill's files (the orchestrator
  `SKILL.md` plus its `references/` stage files) and the skills it drives — not
  the code the lane changed;
- it spans the WHOLE run, so it can see the cross-lane pattern (the same probe
  missing twice, the same correction on lane A and again on lane C) that is
  invisible from inside a single lane;
- it **applies** the fix instead of proposing it. Editing this repo's own agent
  tooling is a routine call you make yourself — decide it, do not hand the
  maintainer a proposal. Escalate through `AskUserQuestion` only when the edit
  would change
  what the flow PROMISES — dropping a gate, lowering a verification tier, loosening
  §0 — never for wording, ordering, or a newly-learned trap.

### 10-0. Measure the run's net effect on the backlog

Before anything else in this step, count what the run did to the issue list and put
both numbers in the wrap report. Then SPLIT the filed count by what §5's open-issue
window did with each finding, because the aggregate cannot tell the two apart and
they mean opposite things:

```bash
# Folded INTO an existing issue rather than filed as a new one. `updatedAt` alone
# does NOT answer this: §4 makes every lane post a CLAIM comment on the issue it
# takes, so a bare updatedAt sweep counts this run's own claims and can never read 0.
# Count the issues whose BODY gained a checklist row instead.
gh issue list --state open --limit 200 --json number,title,updatedAt \
  --jq '.[] | select(.updatedAt > "<this run start ISO>") | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

Report it as one line — `closed N / filed M (new K / folded J)` — and **when M > N,
give the reason in one more line**. `J` is the number §5's window exists to move, and
it is the only one of the three that can be improved without either missing a defect
or leaving one unfixed. With this repo's backlog at zero, `J = 0` is the HONEST answer
for most runs and is not a finding; `J = 0` becomes a signal only once several
findings in one area have already been filed, and then it says the window was searched
by this instance's spelling rather than by the concept. The reason for `M > N` is
almost always one of three, and only the first is healthy:

- **the code really does have that many independent defects** — the run walked into
  an untested area. Fine; say which area, so the next hunt aims there.
- **one root cause was split into many issues** — §5's sweep rule should have folded
  them. This is the failure mode to catch; fold what is still open into an umbrella
  now rather than next time.
- **discoveries were deferred that had session-only evidence** — re-read the `now`
  criteria in `CLAUDE.md`; a discovery whose repro dies with this session is not a
  residual, and deferring it means the next session re-derives it.

**M <= N is NOT a target, and must never become one.** The purpose of the system is
a correct codebase, not a short list: an unfiled finding is strictly worse than a
filed one, because it removes the defect from the record while leaving it in the
product. This count exists to make growth VISIBLE and route it to the right cause —
never to justify not writing a finding down, softening one, or merging two genuinely
independent defects into one vague issue to make the number smaller. If you ever
find yourself weighing whether to file, file.

**Then run the PROMOTION check on every `next` this run filed, because a
deferral is judged against the run that has now HAPPENED, not the run that was
predicted when it was written.** At wrap time nobody re-opens a decision they
remember making deliberately, so this is left as a QUERY rather than as a thing
to remember:

```bash
# For each issue this run filed, does the run's OWN merged diff touch a file
# that issue names? A hit means the deferral was written against a run that
# then went somewhere else.
RANGE="<the sha main was at when this run started>..origin/main"
git diff --name-only "$RANGE" | sort -u > /tmp/run-touched.$$
# The population is the issues this run FILED and left OPEN -- not the folded
# list above, and not the ones it filed and then fixed in the same lane, which
# section 3-a makes routine.
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  # The prose says every `next`; without this the loop also reports items
  # already classified `now`, which are not deferrals at all. `Session-fit`
  # carries no GitHub label, so it has to be grepped out of the body.
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  printf '%s' "$b" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: an issue body names a file by BASENAME far
        # more often than by full path (the bare file name, not the full
        # repo-relative one), and an exact whole-line compare misses
        # every one of those. Measured: the exact form fired on 1 of this run's 2
        # deferrals and missed the one whose body used the basename.
        grep -E "(^|/)$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" \
          /tmp/run-touched.$$ | while read -r hit; do
            echo "PROMOTE #$n -- this run touched $hit"
          done
      done
done
rm -f /tmp/run-touched.$$
```

Pipe the whole loop through `sort -u`: a body naming the same file twice prints
twice, and the duplicate reads as two findings.

**A hit is a prompt for judgement, not a verdict** -- measured on this run's own
two deferrals, one hit on the single file its fix touches and the other hit on
FOUR, three of which its body cited as precedent rather than as files to change.
The check cannot tell a citation from a target, and should not try: its job is to
put the issue back in front of you at the moment the answer has changed.

A hit is still not something to skim past. Either do the item in this run -- the context that
made it cheap is still loaded -- or re-classify it in the issue body with the
reason it still does not belong here.

**And re-read the REASON, not just the files, because a deferral reason can name
a state that has since resolved.** Classifying once, when the item is created,
is right: it is what stops the post-merge moment being re-litigated. But it
freezes the DECISION, and a reason phrased in terms of the run's own transient
state -- "the PR carrying it is still open", "the lane holding that file is
mid-flight", "taking this now would be a fifth review round" -- is true when
written and FALSE the moment that state resolves. Measured in the sibling repo
go-to-k/cdkd on 2026-08-26 (issue go-to-k/cdkd#2259, deferred while
go-to-k/cdkd#2247 was still in review): the fix would have been a fifth review
round on that open PR, and the reason survived unchanged
into the wrap report after that PR merged, where it read as a considered
judgement rather than an expired one. Re-reading a premise that has expired is
not re-litigation; keeping a `next` alive on a reason that has stopped being
true is.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, with the concrete instance attached to each:

1. **Corrections the user made.** Two on one theme — different lanes, different
   wording, same theme — is not a preference, it is a defect in this text. The
   second occurrence is the signal; the first one alone may be a one-off.
2. **Text that was WRONG as written**: a command that failed, a probe that reported
   a clear field while a lane was live, a flag / path / gate name that no longer
   exists.
3. **Steps you had to invent** because the skill is silent about them, and that the
   next run would have to invent again from scratch.
4. **Right instruction, wrong place** — you did the thing, but a step too late (the
   claim posted after the triage, the rebase discovered only after the phantom diff).
5. **Followed it and still paid** — the text was obeyed and a retry happened anyway.

**No evidence, no edit.** If the run was clean, the correct output is one line in the
wrap report ("retrospective: no skill change — §2 / §4 / §8 held"). A skill
that grows from "this would be nice" stops being read to the bottom, and the bottom
is where §9 and §10 live.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) when the failure is mechanically detectable.
  Strongest, and the RIGHT answer whenever the rule was ALREADY in the text and got
  violated anyway: that proves the sentence is not load-bearing, and another
  sentence will not make it so. Escalate rather than restate.
- **This skill's stage file** — `references/<stage>.md`, the file covering the
  step where the lesson fires — when the lesson is about running THIS flow
  (triage, claiming, fan-out, ship order). Never the orchestrator `SKILL.md`,
  whose byte size is capped by `tests/skill-file-payload.test.ts`; it changes
  only when the stage list itself changes.
- **Another skill**, but only one this run actually exercised (`/verify-pr`,
  `/sweep-resources`, `/check`, `/check-docs`). `/hunt-bugs` produced the backlog;
  this flow never runs it, so a lesson about it is not this run's evidence.
- **`CLAUDE.md`, `DESIGN.md`, or a file under `docs/`** when it applies to any work
  in this repo, not just this flow (the last two are in the `docs` gate's scope).
- **Memory** (`~/.claude/projects/.../memory/`) when the lesson is judgmental and
  cross-repo. Weakest enforcement — the landing spot when nothing above can hold the
  rule, not the default one.

**A cross-repo request outranks your own triage.** When the ask was "handle this
across the repos in one session", a discovery made INSIDE that scope cannot be
classified `Session-fit: next` — three tells, any one of which forces `now`: you
are about to file the SAME issue body in more than one repo (that is the split the
request exists to end, not triage); the fix is mechanical and its evidence is live
right now (repro built, files open, a gate cycle already running); or the user
already said "finish it here" for the surrounding task, which a discovery inside it
inherits rather than getting its own budget. The classification fields exist to
make a deferral honest, not to make one available — writing a tidy `Effort` /
`Estimate` for work the session is already positioned to do is the tell that the
fields are being used as an excuse. On 2026-08-20 this run consolidated one lesson
into cdkd, cdk-local and go-to-k/cdk-real-drift, found every PreToolUse gate in the
siblings inert, fixed the matchers in all three — and then filed the remaining
script-level gap as three separate issues, recreating the per-repo split the
request existed to end. It took the user objecting to get it done in the same
SESSION, as a follow-up PR per repo — "same session" is the bar, "same PR" only
when the work is small enough to review together.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is exactly how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4, not
  in a tail section. Gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling beside it. Two
  bullets saying nearly the same thing blunt each other.
- **Carry the evidence inline**, in this file's existing style: date, issue / PR
  number, what actually happened ("On 2026-08-11 ... pushed four minutes earlier").
  A rule with no incident behind it cannot be re-judged or retired later.
- **Pay for what you add**: look for a line this run proved stale, subsumed, or
  wrong, and cut it. Net growth is fine when the lesson is genuinely new; unbounded
  growth is not.
- Do not restate a rule that already lives in `CLAUDE.md` or in another step — point
  at it instead.
- If the lesson is about the FLOW rather than about cdk-real-drift, ONE session
  lands it in all three repos — this skill plus the same-named `work-issues` skill
  in the sibling repos, checked out beside this one as `../cdkd` and `../cdk-local`
  RELATIVE TO THE REPO ROOT (from a `.worktrees/<lane>` cwd — where this flow puts
  you — neither resolves; measured 2026-08-19). They run this flow with
  different gates and different ship steps, so adapt the wording per repo rather
  than copying the section verbatim: three worktrees, three PRs, three gate cycles,
  each under its own repo's rules (cdkd blocks tracked-file edits in its main
  worktree, so it cannot be edited in place). Landing all three is the DEFAULT, not
  the affordable option, because the alternative makes this bullet a duplicate
  GENERATOR: a lesson that hops one repo at a time has every landing session run
  its own §10 retro, which files again into the other two. Measured 2026-08-19:
  twelve open `chore(work-issues)` issues across the three repos were one change,
  and two of them — go-to-k/cdkd#2011 and go-to-k/cdkd#2016, filed twenty minutes
  apart by two different hops, neither seeing the other — were the SAME three
  cdk-local lessons.
  **Filing instead is a WHOLE-REMAINDER exception.** When the session genuinely
  cannot pay for the remaining gate cycles, it files into EVERY repo it has not
  landed in, in ONE turn, and each filed issue names the other filings plus the repo
  the lesson already landed in — so a reader sees the set is complete instead of
  re-deriving it. Partial filing is what produced the pair above. Carry §4's
  `Session-fit` line in every one of them, in English.
  **A lane WORKING a mirror issue does not mirror onward.** The originating session
  already owns all three landings, so re-filing the received lesson into the
  siblings only adds a second and a third copy of it. What IS new is whatever the
  ADAPTATION itself teaches — a gate name that differs, a probe that reads
  differently here — and that is subject to this bullet in turn.
  **Batch a run's lessons into ONE PR per repo**, not one PR per lesson: the gate
  cycle is the per-PR cost, so a run that learned five things ships three PRs. The
  batch that shipped this bullet is that shape — go-to-k/cdk-real-drift#1791 and
  go-to-k/cdk-real-drift#1792 landed in one lane, one PR.
  **Verify the copy against the TARGET repo, claim by claim, before shipping it.**
  Their gates, hooks and ship steps differ, so a sentence that is true here reads as
  authoritative there while being false, and nothing lints instruction prose — the
  next agent simply acts on it. On 2026-08-18 the first mirror of this section
  carried four such claims: a `verify-pr` gate that exempts a non-`src/**` diff, a
  review heuristic that still down-biases `.claude/**`, a `CLAUDE.md` rule the
  sibling does not carry, and a hook it does not ship. A read-only reviewer per
  target repo — its only job being to check each gate name, hook behavior, skill
  name, path convention and cross-reference against that repo's own files — is what
  caught them. Checking in the rule here rather than in agent memory is deliberate:
  memory is per-project-path and per-machine, so it would not load in the very repos
  this bullet sends you to.
  **Verify the cited EVIDENCE too, not only the repo-specific nouns — open the issue
  or PR the sentence names and confirm it says what the sentence claims.** The nouns
  fail when wording TRAVELS; wrong evidence is wrong where it was WRITTEN and then
  travels intact, so a per-repo noun check passes it straight through. This file
  claimed for a day that "on go-to-k/cdk-real-drift#1761 the `check` gate flipped
  rc=0/rc=1 across identical runs (the tsgolint budget-cascade artifact)".
  go-to-k/cdk-real-drift#1761 records a DETERMINISTIC exit 134 from a Vite+ stdout
  `EAGAIN` panic — "Confirmed identical on unmodified `main`", 3/3 in each state per
  go-to-k/cdk-real-drift#1765's table — and neither record
  mentions tsgolint at all. It had already been mirrored into go-to-k/cdk-local#504,
  quoted verbatim, before a reviewer asked to check the records caught it
  (go-to-k/cdk-real-drift#1768). Reading the two records cost one command each.
  **Write every issue / PR reference FULLY QUALIFIED — the `owner/repo#N` form,
  never a bare `#N` and never a half-qualified `cdkd#N` — everywhere in every
  skill doc, this section's own refs included.**
  A bare `#N` renders against whichever repo is READING it, so mirroring silently
  rewrites a correct citation into a wrong one, in both of the shapes available:
  an unqualified `#1761` here lands on go-to-k/cdkd#1761, a real but unrelated EC2
  security-group-rule issue, and an unqualified `#1765` lands on
  go-to-k/cdk-local#1765, which does not exist at all. Neither is hypothetical —
  both were resolved on 2026-08-19, and cdk-local's already-mirrored copy carried a
  bare `#1765` that meant this repo's. The rule is mechanically detectable, so per
  §10-b it is a TEST rather than a sentence: `tests/skill-doc-paths.test.ts` fails
  on any unqualified reference in ANY `.md` under `.claude/skills/**` — the
  orchestrator `SKILL.md` files and the `references/` stage files alike, not just
  this one, because a sentence can travel out of any of them, and `hunt-bugs` already does
  (go-to-k/cdk-real-drift#1796 landed the same change here and in cdk-local). It
  reads plain prose only, which is why the counter-examples in this paragraph can
  stay written as code spans.

### 10-d. Ship it like any other change

Every worktree is gone by §9 and you are back on `main`, where `branch-gate` blocks
a commit. So the retro gets its own worktree:

```bash
# Date-suffix the branch: the previous run's branch was deleted on merge, so
# reusing the name re-creates it as an orphan ref that no PR tracks.
B=chore/work-issues-retro-$(date +%Y%m%d)
git worktree add ".worktrees/${B##*/}" -b "$B" origin/main
cd ".worktrees/${B##*/}"
mise trust && mise install    # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                  # worktrees have no node_modules
```

- `chore:` prefix — this is agent tooling, not `src/**`, and semantic-release turns
  a `fix:` / `feat:` prefix into a release entry describing a cdk-real-drift change
  that never happened.
- English only in every committed line (`non-english-text-gate` enforces it at PR
  time).
- **`vp fmt` REWRITES this file's indentation, and that can change what a
  paragraph belongs to.** This repo's formatter covers markdown (the siblings' does
  not -- measured 2026-08-19: the same probe file is rewritten here and reported as
  "excluded by ignore rules" in cdkd and cdk-local), and it re-indents a paragraph
  that follows a nested list item from 2 spaces to 4, which re-parents it under that
  sub-bullet:

  ```text
  before                                    after `vp fmt`
  - A bullet.                               - A bullet.
    - A sub bullet that is new.               - A sub bullet that is new.
    **A bold lead paragraph.**                  **A bold lead paragraph.**
  ```

  Nothing fails and no gate objects -- the file still renders, just saying something
  else. It bit the go-to-k/cdk-real-drift#1793 lane, whose three verification
  paragraphs in section 10-c were silently absorbed into the last clause above them.
  The fix that survives the formatter is to write such a paragraph as a **bold lead
  paragraph at the parent bullet's own indent** rather than as prose trailing a
  sub-bullet, then run `vp fmt` TWICE and confirm the second run is a no-op. Read
  the reformatted diff before committing; the damage is invisible in the source you
  typed.

- **A skill doc cannot cite a repo path in order to say it is ABSENT.**
  `tests/skill-doc-paths.test.ts` resolves every path-shaped code span in every
  `.md` under `.claude/skills/**` (SKILL.md orchestrators and `references/`
  stage files alike), and it has no negation exemption on purpose: a
  genuinely stale path would otherwise hide behind a "no longer exists" phrasing,
  which is the class the fence exists to catch. Adding an exemption is therefore
  the wrong repair — reword instead. Measured 2026-08-28
  (go-to-k/cdk-real-drift#1829): a draft explaining that this repo has no reviewer
  tier put the dot-claude agents directory in a code span to say it does not
  exist, and went red; naming the absence in PROSE ("this repo ships no
  multi-agent reviewer set and no `/review-pr` skill") passes and reads better.
  Note that this very bullet cannot quote that example in a code span either — it
  went red a second time for exactly that, which is the rule demonstrating itself.
  This bites MIRROR lanes hardest, because adapting a sibling's lesson so often
  means stating that the mechanism it assumes is missing here. Two details of the
  fence make the reword easy once you know them: a span is only checked when its
  FIRST segment is an existing top-level directory, so an invented root is not
  checked at all while anything under the real `.claude` tree is; and `PATH_LIKE`
  requires a leading word character, so a skill name like `/review-pr` is never
  treated as a path. A gate that DOES exist, such
  as the INERT `pr-review` entry in `.markgate.yml`, can still be cited by name.
  Run `vp test run tests/skill-doc-paths.test.ts` before the commit rather than
  after a full gate cycle: on a prose-only diff it is the one fence that can
  actually go red.

- A `work-issues`-only edit is INSIDE the `check` gate's scope
  (`.claude/skills/**` joined it when the skill-split byte-budget fence landed:
  `tests/skill-file-payload.test.ts` and `tests/skill-doc-paths.test.ts` read
  these files, so an edit here must stale the marker their run recorded) and
  outside `docs`; `check-gate` verifies both markers on every commit, and a
  fresh worktree starts with NONE — so run `/check` + `/check-docs` there before
  the commit. `verify-pr-gate` exempts a diff with no `src/**` path, so `/verify-pr` is
  not required for this one; CI still has to be green for `ci-green-gate`. No
  `src/**` change also means no deploy: nothing for `/sweep-resources` to tear down
  and no `deploy-autoarm-gate` token to release.
- Do not let the small diff set the review depth. This repo has no reviewer ladder,
  so the depth IS your own read of the whole diff plus `/verify-pr`'s self-review —
  a wrong rule here propagates into every future session.
- **Merge it before the wrap report, then remove the worktree** — §9 ends with
  every worktree this run added gone, and §10 must not undo that, so finish with
  `git worktree remove .worktrees/<name> && git worktree prune`. This is
  `Session-fit: now` on the criterion that deferring leaves main self-inconsistent:
  the skill would keep telling the next run to do the thing this run just proved it
  gets wrong. Its evidence also dies with this session's context, and leaving the PR
  open is an open PR (NOT CLOSEABLE) besides.

Then report the outcome in one line of the wrap: what changed, in which step, and
the run evidence behind it — or "no skill change" plus what held.

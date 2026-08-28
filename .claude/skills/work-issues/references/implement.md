<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One worktree per lane, then implement

This stage (and stages 6-8) normally runs INSIDE a lane subagent the
orchestrator dispatched — one general-purpose agent per claimed issue, so the
lane's diffs, test output and review round-trips never land in the parent
context. Every rule below applies unchanged inside the lane: hooks fire on the
lane's tool calls (measured on go-to-k/cdk-real-drift#1831, built end-to-end by
a lane subagent on 2026-08-28), and markgate markers land in the lane's own
worktree. Two actions are reserved to the parent's serialization turn and are
NOT the lane's to start: a real-AWS live test (deploy → mutate → revert) and
the merge (the orchestrator's serialization invariant; §9). A lane stops at
merge-ready and reports.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does, sweep
them in THIS lane rather than filing them.** Most defects here are a CLASS, not an
instance: one command factory mishandling a flag, one resolver arm missing a case,
one caller of a shared helper assuming the old contract. Once the root cause is
named, grep for the same shape across `src/` before writing the fix.

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** When the
defect is a MISSING thing, the obvious grep searches for the thing that is missing —
and it can only ever return the sites that already HAVE it. The absent sites are
invisible to it by construction, so the sweep reports itself complete while covering
only the half that was never broken. Ask instead: what makes a site ELIGIBLE for this
defect, and which eligible sites lack the fix?

Measured in go-to-k/cdk-local on 2026-08-27, whose root cause was "a fixture leaks the
Docker image it builds". The sweep was bounded by a grep for the REMEDY
(`docker rmi|docker image rm|docker image prune`); it returned five sites, every one of
them a fixture that already had cleanup, and the lane closed all five and declared the
class done. The correct query is eligibility minus remedy — builds an image, does not
remove one — and it returns six more, plus a seventh that neither query finds. The
remedy-shaped query had seen 5 of 12 eligible sites.

**The same run then repeated the mistake one level up, which is why this is a rule and
not a footnote.** An agent that had just diagnosed the flaw in the orchestrator's query
sized the residue from the ONE instance it had tripped over — "one site, ~30 min" —
rather than asking which query would find the class. It was seven. **A count derived
from the instance you happened to hit is not a count**, and sizing a deferral is exactly
where that bites, because `Effort` and `Estimate` are what a future session budgets from.

The shape recurs here wherever a fix is an ADDED guard rather than a changed line — a
missing `handledProperties` entry, a provider without a validation arm, a resource type
with no drift comparator. Grepping for the guard finds the types that have it.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** This is the
single largest source of unbounded backlog growth: split into N, each site pays the
full fixed cost — triage, claim, worktree, review tier, integ run, merge — for a fix
that is the same edit N times. Swept together, that cost is paid once, and the
reviewer sees the whole class instead of one instance whose generality is invisible.
It also removes the failure mode where sites 2..N sit open long enough for the fix
at site 1 to drift away from them.

Two boundaries, so this does not become a licence for unbounded lanes:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file it as
  an explicit umbrella naming every site, and say which sites this lane DID close,
  so the residue is unambiguous rather than "the rest, somewhere".
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one file
  are two issues; one wrong assumption at five call sites is one. The test is
  whether a single sentence describes the fix at every site.

**A COUNT is a claim, and one RELAYED from a subagent is unearned.** A sweep
reporting "N sites" in its commit message, its issue body and its PR body has
asserted that number three times, and a reader can only re-derive it if the query
is there — so paste the command beside the number. The harder half is the count
you never derived: in this flow the published numbers usually arrive inside a
fan-out agent's summary or a reviewer's finding, already phrased as fact, and get
copied onward without anyone re-running anything.

Measured in cdkd on 2026-08-26 (go-to-k/cdkd#2261), whose run published FOUR such
counts, every one wrong and every one relayed — "all nine sibling sites" (a grep
found 78 across 14 files), "nine mutation probes" (fourteen), "ten unit shapes"
(thirteen), and a "if a third copy ever appears" trigger for a predicate that
already had nine copies. Two went into GitHub artifacts, where they outlive the
session, and the first was the load-bearing argument for deferring that work to
an umbrella — so being wrong by ~9x under-scoped the deferral it justified.

The tell is grammatical rather than technical: a number arriving as a WORD
("nine sites", "a third copy") was counted by a person or an agent, while one
arriving as command output was counted by a machine. Before a relayed count goes
anywhere durable — an issue body, a PR body, this file — run the query yourself
and put it in the text. It is one command. **Run it at the sha that artifact will
describe**, because WHEN is the other half of the rule and the half that actually
fails: a count is correct for the round that reported it and stale by the time it
reaches the PR body, because the body is written once and the branch keeps
moving. Measured in cdk-local on 2026-08-27 (go-to-k/cdk-local#614): one run
published four counts, every one accurate for its round and wrong against the
merged branch — 90 cases (94 by merge); `52 -> 93` for a file that was NEW, so
`0 -> 118` against `main`; `354 -> 368`, where 354 was a mid-PR peak and the real
delta is `337 -> 358` for a feature later deleted; and "6 sites closed" against an
enumeration that omitted one the totals included (7). Three of the four reached PR
bodies and were patched after review caught them. So re-derive every number in a
body after the LAST fix round, not once when you first wrote it — and note that a
count already committed to a durable artifact goes stale the same way: this file
said "nine" `.claude/hooks/*.test.sh` harnesses in two places until 2026-08-28,
when `ls .claude/hooks/*.test.sh | wc -l` returned 15. What worked on that run
was the implementing agent deriving its next count with `awk` and catching its own
correction mid-flight, and declining to relay a path from the orchestrator's
message after grepping and finding no such file.

This repo has no automated fence on that class: its own §8 prose arm ("the CLAIMS
are the artifact") is the only thing standing between a relayed number and a
merged one, and a number is exactly the kind of claim that reads as already
verified.

**And whatever you do file, resolve it against the issues ALREADY OPEN first.** The
sweep above looks for sibling sites in the CODE. This looks for a sibling ISSUE, and
it is a different search with a different answer: the issue that covers your finding
was written from a DIFFERENT site, by a different lane, and names different symbols.
§10-c already runs a rigorous version of this check — the merged file, then open PRs,
then open issues — but its subject is a mirrored skill LESSON. The path that files a
defect follow-up mid-lane, which is where the volume comes from, ran no such check at
all.

**Be honest about how weak the local evidence is.** Measured 2026-08-25, this repo
had **zero open issues**. cdkd's version of this rule rests on a backlog whose count
does not converge (115 open, 94 carrying `Session-fit: next`, all four of the oldest
umbrella-shaped) and cdk-local's on two VERIFIED duplicate filings nine minutes apart
on the mirror path (go-to-k/cdk-local#528 / go-to-k/cdk-local#531). Neither holds here, and the one candidate pair a
title scan surfaces — go-to-k/cdk-real-drift#1786 and go-to-k/cdk-real-drift#1799 —
is NOT a duplicate on reading: go-to-k/cdk-real-drift#1786 mirrors three lessons
from cdk-local's 2026-08-19 run, go-to-k/cdk-real-drift#1799 three from cdkd's
go-to-k/cdkd#2125. Different source repos,
different lessons. So the case for the check here is PROPHYLACTIC: this repo sits on
the same cross-repo mirror flow §10-c already documents as a duplicate GENERATOR, that
flow demonstrably produced a duplicate pair in a sibling, and the check costs one
search plus one line.

```bash
# Search the CONCEPT, not this instance's spelling — the same reason the code sweep
# above greps for a SHAPE rather than a name.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window, which the search index misses: an issue names its sites in
# the body, not the title.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
# `(.body // "")`, not `.body`: an issue filed with no body makes `test` abort the
# whole jq program with "null (null) cannot be matched", so one body-less issue
# silently costs you the entire window.
```

On a HIT, the finding becomes a CHECKLIST ROW in that issue rather than a new issue
number:

```bash
U=$(mktemp)   # NOT a fixed /tmp path — parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing, not style.** The redirect truncates
`$U` before `gh` runs, so an unchained recipe whose `view` fails — wrong number, a
non-repo cwd, a transient error — leaves an empty file that the `printf` fills with
the single new row, and the `edit` then replaces the issue's WHOLE body with it. Every
previously folded finding would be destroyed by the very procedure that exists to
preserve them, which is the one outcome §10-0 says must never happen. `mktemp` rather
than a fixed path for the same reason at a different scale: parallel lanes share the
scratchpad, and a read-modify-write with no concurrency control loses a row when two
folds overlap — so do not run two folds against the same issue concurrently.

On a MISS — with this repo's backlog at zero, the expected outcome for essentially
every filing — file it, and record the search in the body so the next lane can see
the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**This is not a filing threshold, and it must never be used as one.** §10-0 below is
explicit that `filed <= closed` is not a target and that an unfiled finding is
strictly worse than a filed one. Nothing here changes WHETHER a defect gets written
down; it changes only WHERE. An open issue then counts one unresolved root cause
instead of one unfixed site.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses `gh issue create`
without the `Dup-check:` line, and the same refusal covers
`gh api repos/<o>/<r>/issues`, which mints an issue through the REST verb.
`gh issue edit` and `gh issue comment` are deliberately NOT gated. Two things about
that gate a reader will otherwise discover the hard way:

- **Folding is not CHEAPER than minting.** After the same search, minting is one
  command and folding is three (`view`, `printf`, `edit`). The gate makes minting
  non-free while leaving folding untaxed — it removes minting's advantage rather than
  creating one for folding.
- **`gh -R <owner/repo> issue create` IS matched**, which matters because that is this
  very flow's own spelling — §10-c files a mirrored issue into a sibling repo with `-R`,
  from this repo's worktree. So a mirrored filing needs the `Dup-check:` line like any
  other, which is the right outcome: §10-c's own three-window check is exactly what the
  line records. The shared `GATE_GH_C` absorbs the repo flags in every spelling `gh`
  accepts — space, `=`, and glued (`-Ro/r`) — after the `-C`-only form was measured
  letting `gh -R … pr merge` walk past three other gates. Unlike the `pr` gates,
  this one does NOT refuse a foreign `-R`: filing into a sibling is the whole point
  here, and the gate audits nothing repo-specific.
- **A `Dup-check:` line in the `--title` does not count** — the marker must appear in
  a BODY value. The scan used to run over the whole command, so
  `--title 'Dup-check: yes' --body '<no marker>'` satisfied it. A title is not a
  record of having searched anything.
- **`gh api …/issues` reads are not gated.** The collection path is also the LIST
  endpoint, so `gh api -X GET repos/<o>/<r>/issues --paginate` and
  `gh api repos/<o>/<r>/issues -f state=open` pass; only an explicit `POST`, or a
  `title=` field with no method (gh infers POST), counts as a mint.

Never edit in the main checkout. Per lane:

```bash
git worktree add .worktrees/<name> -b wt-<name> main
mise trust .worktrees/<name>/.mise.toml
( cd .worktrees/<name> && pnpm install )     # worktrees have no node_modules
( cd .worktrees/<name> && vp run build )     # ...and no dist/ -- see below
```

**Build BEFORE the first test run, and read a fresh worktree's failures with that
in mind.** A worktree starts with no `dist/`, and any test that spawns the built
CLI then fails on the missing binary rather than on its subject — with an
assertion message about the SUBJECT, which is what makes it costly. Measured on
2026-08-27: a docs-only lane in a fresh worktree saw 13 failures in
`tests/json-empty-on-error.test.ts` (`expected 1 to be 2`), reproduced them with
its own edit stashed, and had begun writing them up as "a peer merge broke main"
— the same file passed in the main checkout, which HAS a `dist/`, so every
comparison pointed at main. `vp run build` in the worktree turned it green with
no other change. **A fresh worktree failing where the main checkout passes is
evidence about the WORKTREE first**, and one build costs seconds against a false
broken-main report.

Do the fix in the worktree (match the existing table/entry pattern exactly; ESM
relative imports need the `.js` extension). **Always add a unit test that fails
without the fix and passes with it** — for a fold/FP fix use the issue's exact
harvested live model; for revert, assert the update document / patch op.
**Check first whether the artifact already has a harness**, because the obvious
place is usually the wrong one: fold-table entries are already covered generically
(`tests/classify.test.ts`, "EVERY entry FOLDS its exact default value"), and hook
behavior by standalone `.claude/hooks/*.test.sh` suites you run BY HAND (`bash
.claude/hooks/<name>.test.sh` from the repo root) — nothing in `vp test run` or CI
invokes those, so a hook change resting on a green suite plus green CI is not
verified at all. Run that harness FROM `.claude/hooks/`, never from a copy parked
elsewhere: every suite resolves its subject from its OWN script path —
`$(dirname "$0")` or the interchangeable `$(dirname "${BASH_SOURCE[0]}")` — with no
env override for it (`BUGHUNT_TRACKER_OVERRIDE` overrides the TRACKER script, not the
hook). A copy under a scratch directory therefore points at a sibling that is not
there, and EVERY case fails on exit 127 — which reads as a regression your change did
not cause. Measured here 2026-08-19 (go-to-k/cdk-real-drift#1777):
`worktree-guard.test.sh` scores PASS=13 FAIL=0 in place and PASS=0 FAIL=13 copied out;
`branch-gate.test.sh` 27/0 and 0/27. The shortcut is most tempting exactly where it
does the most damage — diffing the OLD suite against your NEW hook, where the obvious
move is to redirect `git show origin/main:.claude/hooks/<name>.test.sh` into a temp
file. Write that copy BESIDE the real one instead, as
`.claude/hooks/_old-<name>.test.sh`, and delete it after; it then resolves correctly
(13/13 confirmed). `tests/skill-doc-paths.test.ts` asserts the self-relative
resolution this rule rests on, so amend the rule if a harness ever grows an override.
Extend the harness that exists before writing a new one beside it.

**When the fix is a repo-wide SCANNER — a test that greps every committed file for
a bad pattern — calibrate it against the PRE-FIX broken tree, and do not implement
the issue's signature literally.** An issue describes the signature the way its
author noticed it, which is a description of ONE instance, not a rule with a
measured false-positive rate. Run the candidate rule over the unrepaired tree,
classify every hit by hand, and let that split decide the rule. On 2026-08-19
(go-to-k/cdk-real-drift#1771 -> go-to-k/cdk-real-drift#1782) the issue proposed "a code span immediately followed by an
alphanumeric"; run literally it flagged ~30 spots, most of them idiomatic prose.
Measuring split it cleanly by SIDE — a letter immediately BEFORE a code span gave
5 hits and all 5 were genuine corruption, while the AFTER side gave 13 of which 6
were the ordinary plural suffix (`` `remove`s ``) — so the shipped rule flags the
before-side unconditionally and allows a short `s`/`es` after, catching all 12 real
hits with zero false positives. Then drive the failure direction the same way the
no-`src/**` tier in section 8 requires: `git stash push <the repaired file>`, watch
the scan report the exact hits with their line numbers, and `git stash pop`.

**Calibration and that stash-pop drive read the SAME instances, so between them
they never show the rule catching a defect written a DIFFERENT way.** Running the
candidate over the unrepaired tree buys PRECISION (are the hits real?) plus recall
over the instances that HAPPEN TO EXIST; stashing the repaired file back in then
replays exactly those. Neither touches the SHAPE — the spellings the tree does not
use today, and the contexts that defeat the exemption logic. Follow them with two
more probes, both run against the real tree rather than reasoned about. Every
fence in this repo was put through them on 2026-08-20
(go-to-k/cdk-real-drift#1797) and four of the eight were dead:

- **Write the defect in EVERY spelling the language allows, and confirm each one
  is flagged.** `tests/no-direct-tty.test.ts` asserted `not.toContain('stdin.isTTY')`,
  so `process.stdin['isTTY']`, a destructured `const { isTTY } = process.stdin`
  and `isatty(0)` from `node:tty` all read the same state past a green fence. In
  source the same shape is go-to-k/cdkd#2111: a scanner calibrated at 19 hits /
  zero false positives matched `||` only while the tree already used `??` at four
  sites, and widening it surfaced a real bug nobody had filed.
- **Delete the thing the fence REQUIRES, and watch it fail.** This is the probe
  that finds a wrong POPULATION, and a population derived from the DEFECT is the
  worst kind: `tests/gate-if-matchers-1801.test.ts` (then named for
  go-to-k/cdk-real-drift#1786) selected its gates with
  `filter(h => h.condition.includes('Bash(git commit*)'))`, so deleting the bare
  form dropped a gate OUT of the population instead of failing it — and disarming
  `stale-base-gate` and `ci-green-gate` outright (`if` replaced by a pattern that
  matches nothing) left it green at 7/7. The same day, three more here: the TTY
  fence listed 4 of the 14 files in `src/commands/` and so never looked at
  `ignore.ts`; `tests/skill-doc-paths.test.ts` enumerated `.claude/hooks/*.test.sh`
  and asserted a COUNT, which measures the harnesses that exist and can never
  report the hook that has none (`check-gate.sh`, the one every commit passes
  through); and `tests/releaserc-header-pattern.test.ts` looked ONE plugin up by
  name while `@semantic-release/release-notes-generator` sat there with no
  `parserOpts` at all — which is why all 13 `type!:` merges in this repo's history
  released a version and left no CHANGELOG entry behind.

And ask the dumbest question last: **is anything RUNNING it?** The
`.claude/hooks/*.test.sh` harnesses had no `vp run` task and no CI step — they are
shell, so `vp test run` never saw them — and had been exercised only by hand since
the day each was written (`vp run test:hooks` now runs them, in CI too).

The general shape: **a fence is not evidence until you have watched it go red on
something you had not already counted.** Calibration says it is not noisy; only
the spelling and deletion probes say it is load-bearing.

**Both probes above vary the INPUT. The second axis is the STATE the subject is in
when the input arrives, and that one gets enumerated by ACCIDENT** — every case
reuses whatever fixture setup the first case needed, so the suite covers one row
of a table it never drew, and goes green over every defect in the other rows.
Measured twice in one cdk-local PR on 2026-08-27 (go-to-k/cdk-local#609): a commit
gate shipped 52 green cases with two live fail-opens, was fixed, and shipped 93
green cases with four more. Both times the misses were a file STATE the fixture
never entered — untracked, tracked-but-modified, deleted on disk — not a command
shape nobody imagined, and one of those branches let a NUL byte reach a commit.
DRAW THE GRID: enumerate the states on one axis and the input shapes on the other
and write the cells out. Six states by four command shapes ended it there, made
the deliberately-uncovered cells NAMEABLE rather than merely absent, and surfaced
three FALSE blocks that a one-dimensional suite cannot produce at all. The state
axis is repo-specific, so name it from what the subject actually reads: a
`.claude/hooks/*.test.sh` case reads the TREE (clean, staged-only, dirty,
untracked-only, on `main`, on a branch, inside a worktree), while a fold or
classify fence reads the TIER a property lands in (`declared`, `undeclared`,
`atDefault`, `readGap`) plus the empty-husk shape `isTrivialEmpty` pre-empts —
which is the row a hand-picked case most often skips, and the row
go-to-k/cdk-real-drift#1647 turned out to live in.

**The spelling and deletion probes test the RULE; a third is needed when the
subject is a CLASSIFIER, because there the weak part is the POPULATION.** A classifier is any
function deciding which of several shapes an input is — `classifyTransient` and
`isDependencyViolation` (`src/revert/transient.ts`, `src/revert/apply.ts`),
`classifyStackStatus` and `isResourceNotFoundError` (`src/aws-errors.ts`),
`isNestedUndeclared` (`src/revert/plan.ts`). Its defects live in the shapes
nobody thought to write down, so a suite of hand-picked cases goes green on
exactly the regressions that matter, and no amount of probing the CASES you
have reaches the ones you do not. Cross-repo evidence, 2026-08-21
(go-to-k/cdkd#2001): a region-vs-stack-name predicate shipped THREE green
revisions, each fixing the case the previous review named and breaking a
neighbouring one, every revision passing a suite that had grown a case per
round.

The fence that ends it is a differential walk: enumerate the input space, run
BOTH the new implementation and a transcription of the old one, and fail on any
difference outside an explicitly enumerated set of intended classes. That
inverts the burden — a shape nobody imagined is a failure by default rather than
a silent pass. Get the old implementation from `git show origin/main:<path>`
rather than from memory, and confirm the two agree where they SHOULD before
trusting the cells where they differ. Two ways it goes inert, both measured on
that lane and both siblings of the four dead fences above:

- **Classify by the resulting VALUE, not by the input's shape.** The first cut
  bucketed a differing cell by which input it was, so mutating the fix into a
  total regression left every cell inside the "intended repair" bucket and the
  fence stayed GREEN, while nine ordinary cases caught it.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; one class there was real, intended and never reached, so a pool
  that quietly stops covering one passes as "no regressions" — the same
  "measures the harnesses that exist" failure as the COUNT assertion above.

Two traps that cost most of the apparent false positives there, both worth checking
in any markdown scanner: tokenize per PARAGRAPH, not per line, because a code span
may WRAP a line break and a per-line scan pairs one span's closing backtick with the
next one's opening backtick and invents findings in the prose between them; and
report the line the HIT is on rather than the paragraph start, because a paragraph
in `docs/ARCHITECTURE.md` can run 100+ lines and a start-of-paragraph number sends
the reader hunting. When WRITING, keep each code span on one line for the same
reason — a span that wraps a line break inside a list item also loses the
continuation's indent to `vp fmt`, which is how this very paragraph's neighbour got
re-flowed while being drafted.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole list,
in BOTH directions, before fixing the named entry.** The defect class is "this list
drifted from the repo", and drift almost never produces exactly the one instance
someone happened to notice. Check both that every entry still resolves to something
real AND that everything that belongs is present — the second half is the one that
gets skipped, because the issue only names the first. The evidence is cross-repo:
on 2026-08-19 go-to-k/cdkd#1972 reported one dead path in a security-surface path list; the
audit found a second dead path (stale since an unrelated directory rename) plus four
live authn / credential / exec surfaces never added, so the list under-protected
considerably more than it over-claimed. Then ask what makes the recurrence
mechanical: a list that must stay in sync with the repo is a TEST, not a sentence
asking the next reader to remember. Both audits above are that shape, and
go-to-k/cdk-real-drift#1767 — the mirror of this very lesson, whose source wording
pointed at a unit-test directory this repo does not have — added
`tests/skill-doc-paths.test.ts`, which
asserts every repo path a SKILL.md cites still resolves. It caught that class on
its first run, against this paragraph's own draft.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch <the other lanes' / other agents' files>; STOP and report
if the fix needs a forbidden file" guardrail. This file used to warn that a
subagent's Bash bypasses the PreToolUse gate hooks; that is measured FALSE —
on 2026-08-28 the go-to-k/cdk-real-drift#1831 lane subagent had every gate hook
fire on its own calls exactly as in the parent. The gates are a backstop, not
the plan, either way: the orchestrator still holds the MERGE turn (§9).

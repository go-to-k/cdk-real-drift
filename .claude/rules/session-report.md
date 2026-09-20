# Session-wrap report — the full field reference

AGENTS.md keeps the contract summary and points here. Read this file when
writing a wrap report or filing a deferral.

## The three closing sections

**Every session-wrap / task-complete report MUST end with a "Remaining work"
section AND a "Session close" verdict — unprompted.** The user should never have
to ask "any follow-ups?" or "can I close this session?".

**Scope: only work THIS session created or touched** — residuals of the task
just finished (gaps in what shipped, polish deferred while doing it, issues
filed BECAUSE of this work), never a backlog dump, never a pre-existing open
issue that merely happens to be unresolved. Drop the earlier items once the
session moves to an unrelated task. Work leaving nothing behind gets "Nothing
remaining", even with open issues elsewhere.

**Remaining work** is exactly one of:

- **TODO (issue #N)** — the ONLY bucket meaning follow-ups exist. Every entry
  MUST carry a GitHub issue number, filed BEFORE reporting, and the four
  classification fields below.
- **Won't-do (decided + recorded)** — consciously decided AGAINST, with a
  one-line reason and where it is recorded (PR body, in-code comment, issue
  comment). No action needed.
- **Nothing remaining** — stated after actually auditing for deferred polish and
  reviewer nits.

**Session close** is a one-line verdict: **CLOSEABLE** or **NOT CLOSEABLE
(waiting on: ...)** naming the blocker. CLOSEABLE requires ALL of: working tree
clean; no open PRs owned by this session; no running background tasks / hunts /
subagents; no AWS resources pending cleanup (bughunt sentinel clear); every TODO
filed as an issue; zero `Session-fit: now` TODOs open.

## The four TODO fields

**Decide them WHEN THE ITEM ARISES, not at wrap time.** By wrap time the
evidence for the call — which files were open, which verification cycle was
already being paid for — is gone, and a retrospective guess is worth little.
Record them **in the issue body** so they outlive the session.

```text
Session-fit: now (do it in this session) | next (not this session) — <reason>
Severity: high | medium | low — <what stays broken while it is undone>
Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
Estimate: <duration, e.g. ~1-3 h> — <what eats the time>
```

A report adds a fifth line, **`Notes`**, for session-specific context (`none`
when there is nothing); the issue body stays at the four classification lines.

**The four answer four DIFFERENT questions and none is a spelling of another.**
`Session-fit` is the decision, `Severity` the cost of leaving it undone,
`Effort` which verification cycle the fix drags, `Estimate` the hours. The one
sanctioned link: `Severity: high` forces `now` unless external input blocks it.
Do not collapse `Severity` into `Session-fit` — a `high` item can still be
`next` (external input) and a `low` one is usually `now` (it lands in a file
this session already has open). `Severity` says what a USER suffers,
`Session-fit` what THIS session does; the moment the two merely track each
other, one field is wasted. Nor `Effort` into `Estimate`: "one live run" is a
kind of cost, and the hours depend on which fixture.

**The keys are spelled identically everywhere** — issue body, English report,
Japanese report; never translated or renamed per context. **No bare tokens**,
because a value must be readable without knowing the internal scale: write
`Session-fit: next (not this session)` and never a lone `next`; `Effort: large
(L)` and never a lone `L`; `Severity` as a WORD and **never as an initial** (the
initials collide with `Effort`'s both ways — `M` is `medium` on either scale,
and `L` reads _low_, the least urgent thing there is, against _large_, the
biggest). Always BOTH `Effort` and `Estimate`: dropping the duration and keeping
the letter is exactly the failure this split exists to end.

## `Severity` and `Effort` are ALSO labels

The two lines stay exactly as written and are mirrored as `severity:high` /
`severity:medium` / `severity:low` and `effort:small` / `effort:medium` /
`effort:large`, because prose is invisible to every query the backlog is triaged
with. Set them at filing time (`gh issue create ... --label severity:high
--label effort:large`) and again when a claim rewrites an old packed body into
the four-line shape — where `Severity` first exists for most of the backlog.

**Only these two get labels.** `Session-fit` is re-decided at claim time and a
label silently disagreeing with the body is worse than none; `Estimate` is a
free-form duration whose informative half is what a label cannot hold. The
prefixed full words are the no-bare-tokens rule applied to a label.

**The PR inherits them automatically.**
`.github/workflows/pr-inherit-issue-labels.yml` copies every label of the issues
a PR closes onto the PR (add-only, minus the release-management family) when the
PR is opened, reopened, or its body edited, reading the labels the issue carries
AT THAT MOMENT — so label the ISSUE at CLAIM time, before the lane's PR exists,
never by hand on a PR.

## Scales

**`Severity`.** `high` = a wrong result, data loss, a security surface, or
something a user hits in normal operation; `medium` = a capability is missing
but there is a workaround, or it only shows up under a specific condition;
`low` = internal tidiness, invisible to users. **Rate what a user experiences,
never why this session should do it** — "leaving main self-inconsistent" is a
`Session-fit: now` trigger, not a Severity level; rating it `high` smuggles a
Session-fit trigger through the wrong field, and a misrated `high` then forces
`now` by itself.

**`Effort`** measures the verification tail rather than the edit: `small` = edit
plus unit tests, riding verification this session already pays for; `medium` =
one re-review round, or a live run this session was not otherwise going to make;
`large` = a NEW fixture has to be WRITTEN, or a behavior change needing its own
PR plus review.

**Calibration.** RUNNING an existing verification is not a reason to defer — a
passing run costs minutes and a few hundred tokens, and one riding the session's
current lane costs zero. What is genuinely expensive is WRITING a new fixture,
and a run that FAILS. Both are `Effort` / `Estimate` lines, not reasons: the
fixture is written cheapest while the subsystem is loaded, and unbounded here is
unbounded next session too. Review of a larger diff also grows superlinearly and
that cost is real, but it is a reason to SPLIT the PR, not to end the session,
and it belongs under `Effort` — the `large` line above. **PR shape is never a
`Session-fit` criterion**: "it needs its own PR" / "it is a separate review
surface" / "unreviewable together" are `Effort`, not `next`.

## `now` is the DEFAULT; `next` needs one of two reasons

**Write the CONTEXT TEST before the decision**: list the files the fix touches
or must read to be made correctly (tests and docs included), and say, per file,
whether this session already READ it — read, edited, or reviewed in a diff; a
reviewer's read set counts exactly like an author's. ONE loaded file makes the
item `now`: a fresh session pays the launch probe, install, build, the module
read and the evidence re-derivation BEFORE its first edit, while this session
pays the edit alone. Precedence: `next` reason (a) asks whether the work CAN
finish here and is decided first; (b) is what the test gates.

- **`now`** — any of: a file the fix touches is loaded; skipping it leaves main
  self-inconsistent (docs contradicting shipped code, a stale rationale comment,
  a fixture that no longer discriminates); it blocks another lane; it rides an
  EXISTING verification; its evidence exists only in this session (a live read, a
  hand-injected drift, a measurement); the user cannot use the result yet
  (unreleased — "merged" is not done); **leaving it loose compounds** — a fixture
  or corpus case not yet written for a subsystem this session holds, a pattern
  landed at some sites and not others, a guard with a known hole; or
  **`Severity: high`**, rated on the scale above and never on the decision it
  forces, unless (a) blocks it.

  **Residuals of a just-merged lane** — polish, nits, parity gaps, sibling sites
  a review named — are the hottest context there is and are `now` by the test
  above; "only a residual" names no cost. Writing a NEW live-AWS fixture is
  `Effort: large`, a cost to record, never a reason to defer.

- **`next`** — ONLY one of: (a) external input (a quota, an upstream fix,
  credentials or a host a fresh session may lack, a file held by another lane's
  OPEN PR, a maintainer decision already asked through `AskUserQuestion` and
  unanswered — a routine call is yours to make); or (b) the work is COLD AND
  HEAVY — nothing the fix touches or must read was read this session, no `now`
  criterion fires, AND doing it here is clearly WORSE than fresh, not merely as
  costly: the reason names the modules to load and says why loading them beside
  THIS session's context degrades the work. Cold alone is not (b) — a small cold
  fix is `now`. (b) is legitimate and never to be forced through, but it must
  stay RARE: a (b) fired twice in one run is the reflex, not the reason.

  **Nothing about the SESSION is a reason**: its length, the context left, "it
  has done enough", a wrap report already drafted, the PR already merged. The
  wrap reflex (file → classify → close) fires exactly when the context is
  richest, which is why it produces `next` — and why the context test is written
  first. Before the final report, re-run the test on every `next` it lists.

**Before writing `Session-fit: next`, NAME the command that verifies the fix** —
concretely (not "run the tests": the test file; not "check it live": the stack
and the region) — and say a fresh session will be able to run it. A deferral is
a PREDICTION, and an unstated one is never checked, so the field decays into
naming the KIND of work — classifying by MEANS not PURPOSE, which no list of
`now` triggers catches. If naming it is HARD, that difficulty IS the finding,
and it is one of four things: the verifier is bound to THIS run's live AWS state
(a stack this run must delete before it can ship, a hand-injected drift, a clean
window on the shared-name suite) or to credentials a fresh session may not hold;
it is bound to THIS host (CPU architecture, an installed toolchain, a pulled
container image); it does NOT EXIST yet and writing it is most of the work —
write it NOW while the subsystem is loaded; or you cannot name it at all, which
is an unbounded deferral. When you CAN name the check and any machine can run
it, say so in one line beside `Session-fit`.

**`Session-fit: next` is NOT available for work discovered inside a scope the
user framed as "do this across the repos in one session".** Three tells force
`now`: (1) you are about to file the SAME issue body in more than one repo —
that is the split the framing exists to end, not triage; (2) the fix is
mechanical and its evidence is live right now (the repro is built, the files are
open, a gate cycle is already running); (3) the user already said "finish it
here" for the surrounding task, and a discovery inside it inherits the
instruction. The four fields exist to make a deferral HONEST, not to make one
available — a defensible-looking `Effort` / `Estimate` for work the session is
already positioned to do is the tell. "Same session" is the bar; "same PR" only
when the work reviews together.

**A newly DISCOVERED bug is `now` even in a COLD subsystem.** Its expensive part
is the EVIDENCE — the repro you built, what you watched happen, the number you
measured — which is what an issue body cannot carry cheaply, unless that
evidence is already PERSISTED in the repo (a corpus case harvested into
`tests/corpus/`, a committed fixture), when (b) applies as usual. If you defer
anyway on (a) or (b), put the EVIDENCE in the body, not just the diagnosis.

## The template

**One field per line — never pack two onto one**, and keep the field names and
their order identical every time. A field with nothing to say gets an explicit
`none`, never omission.

```text
## Remaining work
- TODO #<N> — <what it is>
  - Session-fit: now (do it in this session) | next (not this session) — <one line>
  - Severity: high | medium | low — <what stays broken while it is undone>
  - Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  - Estimate: <duration> — <what eats the time>
  - Notes: <session-specific context | none>
- Won't-do — <what>
  - Why: <one line>
  - Recorded: <PR body | in-code comment | issue>
(or the single line: Nothing remaining)
```

When `next` TODOs exist, close with the not-this-session line
(`Not this session — start a fresh session with: <literal command>`),
unconditioned, never labeled "Handoff" / "Next steps"; `next` items never appear
on the State line.

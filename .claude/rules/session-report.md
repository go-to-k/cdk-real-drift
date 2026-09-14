# Session-wrap report — the full field reference

Moved out of CLAUDE.md by the token-diet split: CLAUDE.md keeps the contract
summary and points here. Read this file when writing a wrap report or filing
a deferral.

- **Every session-wrap / task-complete report MUST end with a "Remaining work"
  section AND a "Session close" verdict — unprompted** (mirrors
  go-to-k/cdkd#1257; the user should never have to ask "any follow-ups?" or
  "can I close this session?"). **Scope: only work THIS session created or
  touched** — residuals of the task just finished (gaps in what shipped, polish
  deferred while doing it, issues filed BECAUSE of this work), never a backlog
  dump; never a pre-existing open issue that merely happens to be unresolved;
  and drop the earlier items once the session moves to an unrelated task. Work
  leaving nothing behind gets "Nothing remaining", even with open issues
  elsewhere. **Remaining work** — exactly one of: **TODO (issue #N)** (the ONLY
  bucket meaning follow-ups exist — every entry MUST have a GitHub issue
  number, filed BEFORE reporting, AND the four classification fields below);
  **Won't-do (decided + recorded)** (consciously decided AGAINST doing, with a
  one-line reason and where it is recorded — PR body, in-code comment, issue
  comment; no action needed); **Nothing remaining** (stated after actually
  auditing for deferred polish and reviewer nits).
  **Session close** — a one-line verdict: **CLOSEABLE** or **NOT CLOSEABLE
  (waiting on: ...)** naming the blocker. CLOSEABLE requires ALL of: working
  tree clean; no open PRs owned by this session; no running background tasks /
  hunts / subagents; no AWS resources pending cleanup (bughunt sentinel clear);
  every TODO filed as an issue.

  **The four TODO fields — decide them WHEN THE ITEM ARISES, not at wrap
  time.** By wrap time the evidence for the call (which files were open, which
  verification cycle was already being paid for) is gone, and a retrospective
  guess is worth little. Record them **in the issue body** so they outlive the
  session. The issue body and the report use the SAME four lines, one field per
  line (an issue also carries a filing-time `Dup-check:` line — see
  `/work-issues` §5 — which is not a fifth classification field):

  ```text
  Session-fit: now (do it in this session) | next (not this session) — <reason>
  Severity: high | medium | low — <what stays broken while it is undone>
  Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  Estimate: <duration, e.g. ~1-3 h> — <what eats the time>
  ```

  A report adds a fifth line, **`Notes`**, for session-specific context (`none`
  when there is nothing); the issue body stays at the four CLASSIFICATION
  lines — what belongs there is only the part that outlives the session.

  **The four answer four DIFFERENT questions and none derives from another**:
  `Session-fit` is the decision, `Severity` the cost of leaving it undone,
  `Effort` which verification cycle the fix drags, `Estimate` the hours. Do not
  collapse `Severity` into `Session-fit` — a `high` item can still be `next`
  (external input) and a `low` one is usually `now` (it lands in a file this
  session already has open); `Severity` says what a USER suffers,
  `Session-fit` what THIS session does; the moment the two merely track each
  other, one
  field is wasted. Nor `Effort` into `Estimate`: "one live run" is a kind of
  cost, and the hours depend on which fixture.

  **The keys are spelled identically everywhere** — issue body, English report,
  Japanese report; never translated or renamed per context. **No bare tokens**,
  because a value must be readable without knowing the internal scale: write
  `Session-fit: next (not this session)` and never a lone `next`;
  `Effort: large (L)` and never a lone `L`; `Severity` as a word and **never as
  an initial** (the initials collide with `Effort`'s both ways — `M` is
  `medium` on either scale, and `L` reads _low_, the least urgent thing there
  is, against _large_, the biggest); and always BOTH `Effort` and
  `Estimate` — dropping the duration and keeping the letter is exactly the
  failure this split exists to end.

  **`Severity` and `Effort` are ALSO LABELS on a filed issue** — the two lines
  stay exactly as written, mirrored as `severity:high` / `severity:medium` /
  `severity:low` and `effort:small` / `effort:medium` / `effort:large` —
  because prose is invisible to every query the backlog is triaged with
  (ranking by `Severity` costs one `gh issue view` per candidate;
  `gh issue list --label severity:high` is one call). Set them at filing time
  (`gh issue create ... --label severity:high --label effort:large`) and again
  when a claim rewrites an old packed body into the four-line shape — where
  `Severity` first exists for most of the backlog. **Only these two get
  labels**: `Session-fit` is re-decided at claim time and a label silently
  disagreeing with the body is worse than none; `Estimate` is a free-form
  duration whose informative half is what a label cannot hold. The prefixed
  full words are the no-bare-tokens rule applied to a label. Enforced by
  `.claude/hooks/issue-classification-label-gate.sh`, which refuses a
  `gh issue create` / `gh issue edit` whose body states a value
  the issue's labels do not carry (`gh issue comment` is not gated; on `edit`
  it asks gh what the issue already carries, and fails OPEN when gh cannot
  answer). **The PR inherits them automatically** —
  `.github/workflows/pr-inherit-issue-labels.yml` copies every label of the
  issues a PR closes onto the PR (add-only, minus the release-management
  family) when the PR is opened, reopened, or its body edited, reading the
  labels the issue carries AT THAT MOMENT — so label the ISSUE at CLAIM time,
  before the lane's PR exists, never by hand on a PR.

  **Scales.** `Severity`: `high` = a wrong result, data loss, a security
  surface, or something a user hits in normal operation; `medium` = a
  capability is missing but there is a workaround, or it only shows up under a
  specific condition; `low` = internal tidiness, invisible to users. **Rate
  what a user experiences, never why this session should do it** — "leaving
  main self-inconsistent" is a `Session-fit: now` trigger, not a Severity
  level, and copying it here makes that flavour of `high` permanently
  un-`next`-able. `Effort` measures the verification tail rather than the
  edit: `small` = edit plus unit tests, riding verification this session
  already pays for; `medium` = one re-review round, or a live run this session
  was not otherwise going to make; `large` = a NEW fixture has to be WRITTEN,
  or a behavior change needing its own PR plus review. Calibration: RUNNING an
  existing verification is not a reason to defer (measured over the 268 rows
  of cdkd's integ ledger, 2026-08-20: median run 85 s, mean 4.6 min, p90 8.8
  min — a passing run costs a few hundred tokens, and one riding the session's
  current lane costs zero). What is genuinely expensive is WRITING a new
  fixture, and a run that FAILS. Both are `Effort` / `Estimate` lines, not
  reasons: the fixture is written cheapest while the subsystem is loaded, and
  unbounded here is unbounded next session too. Review
  of a larger diff also grows superlinearly and that cost is real, but it is
  a reason to SPLIT the PR, not to end the session,
  and it belongs under `Effort` — the `large` line just above, where this same
  bullet already puts it. Until 2026-09-05 it ALSO stood here as a third thing
  to "defer on": the PR-shaped criterion arriving through the back door, in the
  paragraph that had just placed it correctly. A body wording it `unreviewable`
  is refused by `.claude/hooks/issue-deferral-criteria-gate.sh`, so the two
  halves of this bullet contradicted each other AND the gate.

  **`now` is the DEFAULT; `next` needs one of two reasons.** At the wrap of
  nearly every recent session the maintainer has had to ask whether the
  leftover would not be cheaper to finish HERE, with the context already
  loaded — and every time the answer was yes: the item was re-classified `now`
  and done in that session (go-to-k/cdkd#3083 is the latest, ~25 min because
  every file it touched was already read). This rule pre-answers that
  question; it must never need asking again.

  **Write the CONTEXT TEST before the decision**: list the files the fix
  touches or must read to be made correctly (tests and docs included), and
  say, per file, whether this session already READ it — read, edited, or
  reviewed in a diff; a reviewer's read set counts exactly like an author's.
  ONE loaded file makes the item `now`: a fresh session pays the launch
  probe, install, build, the module read and the evidence re-derivation
  BEFORE its first edit, while this session pays the edit alone. Precedence:
  `next` reason (a) below asks whether the work CAN finish here and is
  decided first; (b) is what the test decides.

  - **`now`** — any of: a file the fix touches is loaded (above); skipping it
    leaves main self-inconsistent (docs contradicting shipped code, a stale
    rationale comment, a fixture that no longer discriminates); it blocks
    another lane; it rides an EXISTING verification (calibration above); its
    evidence exists only in this session (a live read, a hand-injected drift,
    a measurement); or the user cannot use the result yet (unreleased —
    "merged" is not done); **leaving it loose compounds** — a fixture or
    corpus case not yet written for a subsystem this session holds, a pattern
    landed at some sites and not others, a guard with a known hole: the cost
    of undone grows with every session that passes, and the fixture case is
    the clearest — deferred, it is the piece that never lands; or
    **`Severity: high`** — a wrong result, data loss, or a security surface
    is `now` unless (a) blocks it; (b) never overrides a `high`.
    **Residuals of a just-merged lane** — polish, nits, parity gaps, sibling
    sites a review named — are the hottest context there is and are `now` by
    the test above; "only a residual" names no cost. Writing a NEW live-AWS
    fixture is `Effort: large`, a cost to record, never a reason to defer; a
    corpus case is harvested from the live read this session already has
    (`/work-issues` §3-b).
  - **`next`** — ONLY one of: (a) external input (a quota, an upstream fix,
    credentials or a host a fresh session may lack, a file held by another
    lane's OPEN PR, a maintainer decision already asked through
    `AskUserQuestion` and unanswered — a routine call is yours to make); or
    (b) the work is COLD AND HEAVY — nothing the fix touches or must read was
    read this session, no `now` criterion fires, AND doing it here is clearly
    worse than fresh: it needs a large body of context this session would
    load from zero anyway, or the context this session does hold would
    degrade the work (a security surface read through an unrelated
    subsystem's assumptions). Cold alone is not (b) — a small cold fix is
    `now`. (b) is legitimate and never to be forced through — but it must
    stay RARE: the reason names the context the work needs and why THIS
    session is the wrong one to load it; a (b) fired twice in one run, or on
    an item with a loaded file, is the reflex, not the reason. **Nothing
    about the SESSION is a reason**: its length, the context left, "it has
    done enough", a wrap report already drafted, the PR already merged. The
    wrap
    reflex (file → classify → close) fires exactly when the context is
    richest, which is why it produces `next` — and why the context test is
    written first. Before the final report, re-run the test on every `next`
    it lists: the report is the last moment the loaded context can still be
    spent.

  **Before writing `Session-fit: next`, NAME the command that verifies the
  fix** — concretely (not "run the tests": the test file; not "check it live":
  the stack and the region) — and say a fresh session will be able to run it.
  A deferral is a PREDICTION, and an unstated one is never checked, so the
  field decays into naming the KIND of work — classifying by MEANS not PURPOSE,
  which no list of `now` triggers catches. If naming it is HARD, that
  difficulty IS the finding; it is one of four things: the verifier
  is bound to THIS run's live AWS state (a stack this run must delete before it
  can ship, a hand-injected drift, a clean window on the shared-name suite) or
  to credentials a fresh session may not hold; it is bound to THIS host (CPU
  architecture, an installed toolchain, a pulled container image); it does NOT
  EXIST yet and writing it is most of the work — the one case where `next` is
  unambiguously right, and right BECAUSE you could name what is missing; or you
  cannot name it at all, which is an unbounded deferral.
  Measured 2026-08-26: go-to-k/cdk-local#560 deferred on "a fixture /
  base-image change on a different axis" — the work's CATEGORY. Its defect was
  a Go RIE segfault under `linux/amd64` emulation on the arm64 host it was
  FILED from, so the real verification was "run those fixtures on an arm64
  host", which nothing guarantees a fresh session has; the maintainer caught
  it, not the flow. Converse: when you CAN name the check and any machine can
  run it, say so in one line beside `Session-fit`. `/work-issues` §3-b applies
  this to a deferral that becomes a filed ISSUE.

  **`Session-fit: next` is NOT available for work discovered inside a scope
  the user framed as "do this across the repos in one session".** Three tells
  force `now`: (1) you are about to file the SAME issue body in more than one
  repo — that is the split the framing exists to end, not triage; (2) the fix
  is mechanical and its evidence is live right now (the repro is built, the
  files are open, a gate cycle is already running); (3) the user already said
  "finish it here" for the surrounding task, and a discovery inside it
  inherits the instruction. The four fields exist to make a deferral HONEST,
  not to make one available — a defensible-looking `Effort` / `Estimate` for
  work the session is already positioned to do is the tell (2026-08-20: a
  session consolidating one lesson across cdkd, cdk-local and this repo fixed
  the inert gates in all three, then filed the script-level residue as three
  separate issues; the user had to object to get it done in the same SESSION,
  one follow-up PR per repo). "Same session" is the bar; "same PR" only when
  the work reviews together.

  **A newly DISCOVERED bug is `now` even in a COLD subsystem.** Its expensive
  part is the EVIDENCE — the repro you built, what you watched happen, the
  number you measured — which is what an issue body cannot carry cheaply —
  unless that evidence is already PERSISTED in the repo (a corpus case
  harvested into `tests/corpus/`, a committed fixture), when (b) applies as
  usual. If you defer anyway on (a) or (b), put the EVIDENCE in the
  body, not just the diagnosis.

  **One field per line — never pack two onto one**, and keep the field names
  and their order identical every time. A field with nothing to say gets an
  explicit `none`, never omission:

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

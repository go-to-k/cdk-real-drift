<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. Its live-test rules decide how each PR is verified:

**Run the integ LAST, and DECLARE the tree final, in words, to whoever is still
editing it.** The `integ` gate is `hash: diff` over `src/**` and
`tests/integration/**`: even a comment-only review fix to an in-scope file
stales the marker and costs a full fixture run (three real-AWS runs of one
fixture, the third for a zero-non-comment round — go-to-k/cdkd#2261). Tell the
implementer to batch all remaining findings into ONE commit and report when the
tree is FINAL — unsaid, it will re-verify per finding. Reviewer-side: scope the
round to the delta and take its findings all at once, not trickled.

- **fold / FP / classify fix** → the harvested **corpus** case is authoritative
  live data. If it is pinned by `vp test run corpus-replay` AND was live-proven
  in its originating hunt (the issue carries the real repro), that IS the live
  evidence — no fresh deploy. State the deferral explicitly.
- **toolchain / CI / skill fix (nothing under `src/` in the diff)** → no
  live-test tier, no corpus; `verify-pr-gate` exempts the diff — an exemption
  from the LIVE test, not from verifying. A diff doing both owes both arms
  (go-to-k/cdk-real-drift#1774: undivided, this tier sent a pure prose diff to
  run a command 3–5×, which for a SKILL.md edit does not exist):
  - **It changes what a command or gate DOES** (a `vite.config.ts` task,
    lint/typecheck config, `.github/workflows/ci.yml`, `.claude/hooks/` logic)
    → the verification IS that command, run 3–5× BEFORE and AFTER, FAILURE
    direction driven too. Run _the command your own diff changes_: the hook's
    own `.claude/hooks/<name>.test.sh`, the workflow step's own command, the
    changed task. `vp run check` format-checks `ci.yml` as text and never
    EXECUTES a step or hook — a probe that cannot fail (measured 2026-08-19).
  - **It changes PROSE only** (a skill, rule, doc — including this file) → the
    CLAIMS are the artifact; repeating an adjacent command 5× measures nothing.
    Resolve every gate, hook, skill, path, task and command the text names
    against this repo's own files, and RUN each command it sends the next agent
    to run, confirming the output matches the promise — §10-c's claim-by-claim
    pass, owed even for text ported from a sibling;
    `tests/skill-doc-paths.test.ts` mechanizes the path/issue-ref halves.

- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it** — every signal says pass
  (go-to-k/cdkd#2125 shipped past unit tests, a real-AWS fixture and four
  reviewers). Here the state is the BASELINE `record` writes under
  `.cdkrd/baselines/` and the rules `ignore` appends: a `verify.sh` that runs
  `record` and only THEN mutates never exercises the `record`-less first-run
  path where the FIRST `check` both creates the situation and must handle it.
  When a fix keys on state an earlier step wrote, ask **which step writes it in
  the fixture, and which in the reachable case**; if they differ, add the arm
  where one operation does both, and prove it DISCRIMINATES by mutating the
  fix: the ORIGINAL arm still passes, the new one fails.
- **A `cleanup` that ALSO runs before the run must not destroy anything the run
  then needs.** A `WORKDIR="$(mktemp -d …)"` computed at load time, removed by
  `cleanup`, called pre-run: the directory is gone before its first write, and
  the symptom is a bare `No such file or directory` hundreds of lines from the
  cause (cost a real-AWS cycle in cdkd). AWS resources are immune — creating
  them IS a phase — a scratch path computed at variable-definition time is not.
  Anything `cleanup` removes must be re-created by a phase or created after the
  pre-run call. This repo's fixtures arm `trap cleanup EXIT` with no pre-run
  call; if you add one, dry-run against stubs first.
- **When a fix round produces the NEXT round's blocker twice, stop reviewing
  the patch and question its SHAPE** (`/verify-pr` step 5 re-reads the whole
  diff each run). Blockers in a cascade are found by executing a probe or
  tracing a window, never by re-reading the diff. After round two, name what
  the rounds have in COMMON —
  usually one structural absence — then take the NARROW fix, file the
  structural one, and reference it from the narrow fix; new code at round five
  is how round six happens.

  **Filing the structural fix does not STOP the cascade**
  (go-to-k/cdk-local#596: filed at round five, ran to TWELVE — eleven instances
  of one defect class in one PR, five introduced by fixes). What ended it:
  making the artifact **CLAIM LESS** — printing raw output and naming both
  outcomes instead of a verdict, because a command that claims nothing cannot
  claim something false. The tell: each fix more SOPHISTICATED than the last
  while the plain rc-only sweeps beside it were right throughout
  (`grep -q 'does not exist'` also matched botocore's
  `The source_profile ... does not exist`, raised before any network call, so a
  broken profile reported CLEAN having queried nothing). Expect the fix to feel
  like a retreat — it converges. Corollaries, both paid for there:

  - **Fence the REMEDIATION, not just the detection.** A destroy built from
    names missing a required suffix exits 0 SILENTLY; every fence pinned the
    DETECTION, so restoring that line left the suite green. If a procedure both
    detects and repairs, the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** Say what
    the next finding would have to SHOW, not what you will do about it ("if
    instance nine appears, delete the whole thing" — when it arrived, deleting
    would have left NO check at all).

  Two shapes recur, distinguishable a round apart:

  - **TWO SPELLINGS OF ONE QUESTION** — name the SITE THAT OWNS the question;
    every other site calls or copies its predicate VERBATIM (go-to-k/cdkd#2134
    ended only when the authority's test was copied character for character — a
    better second spelling passes its own test and regenerates the cascade).
  - **A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN ANSWER** — make that
    component REPORT. The tell: each proxy is wrong in BOTH directions at once
    (misses real cases AND fires on unreal ones). When a fix lands on a new
    OBSERVABLE — "it threw", "the text survived", "a marker exists" — ask
    whether the fact is derivable outside the component that decides it; if
    not, the rounds are unbounded (go-to-k/cdkd#2157 / go-to-k/cdkd#2166).
    Drift analogue: any question only AWS's own readback can answer — which is
    why the corpus outranks any predicate reasoned about in isolation.

- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis** —
  each proxy tried, the input that broke it, the number it produced; a
  diagnosis alone makes the next session re-run every probe (worked example:
  go-to-k/cdkd#2166).
- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either** — forwarding both hands the implementer a
  contradiction with LESS context than you have; forwarding only the reassuring
  one is how a blocker ships. Read the disputed lines; say which reviewer was
  right and why.

  What to measure in the command arm (all confirmed here 2026-08-19,
  go-to-k/cdk-real-drift#1768):

  - **An exit code can lie in EITHER direction, so drive both.** _Non-zero
    meaning nothing_: `vp run check` exited **134** on a clean tree with **0
    errors** (Vite+ stdout `EAGAIN` panic), deterministic 3/3 per state, 0
    after the one-line build-config fix (go-to-k/cdk-real-drift#1761 /
    go-to-k/cdk-real-drift#1765); the hazard is a redirect swallowing the exit
    code turning a RED tree green — hence
    `tests/vp-run-check-redirect-1761.test.ts` asserting the `exit 1` survives.
    _Zero meaning nothing_: no measured case here; cite the sibling's
    go-to-k/cdk-local#504 as the sibling's, and measure the command YOU
    changed.
  - **`vp pack` BEFORE reading any `vp run test` verdict in a fresh worktree —
    and re-run a red from that one file before believing it.** No `dist/`
    fails 13 tests of `tests/json-empty-on-error.test.ts` deterministically
    (they spawn the built CLI); with `dist/` freshly packed, three of the 13
    failed once and the identical re-run went 343/343 rc=0. Tell them apart by
    the COUNT — 13 means no `dist/`, fewer means the flake — and never let a
    single red run stand as the verdict.
  - **The COUNT stops discriminating once the host is loaded; re-run at
    `--maxWorkers=4` instead.** Every suite that SPAWNS the built CLI or `vp`
    is racing the machine's other agents for cores, and the 5,000 ms default
    timeout gives way first — reds land in whichever subprocess suites the run
    scheduled during the crunch, at a count that says nothing about `dist/`.
    Measured 2026-09-02 (go-to-k/cdk-real-drift#1854): two files failed 10,
    then 13, then 14 tests across three full runs with `dist/` freshly packed;
    both passed in ISOLATION, and one `vp test run --maxWorkers=4` over the
    whole suite was 352 files / 6,665 tests green. The discriminator is the
    RE-RUN SHAPE, not the count: isolation, reduced parallelism, and waiting
    for the host to quiesce turn a load artifact green while leaving a real
    failure red. Measure the host first — the same day, at `load average 137`,
    `--maxWorkers=4` was no longer enough and one test timed out running its
    file ALONE. `uptime` costs nothing and tells you whether the machine, not
    the diff, is the subject.
  - **Repeating a `vp run <task>` DOES re-execute here** — `check` (5/5) and
    `test` (3/3) reported `not cached because it modified its input`. Do not
    import the sibling's cache-hit warning; the local cache trap
    (go-to-k/cdk-real-drift#438) is already handled by `cache: false` in
    `vite.config.ts`.
  - **Inject the failure anywhere LINTED — here that includes the tests
    tree.** A non-underscore-prefixed unused variable fails `vp run check`
    rc=1 from `src/` AND from `tests/` (`lint.ignorePatterns` re-includes the
    tests tree, excluding only `tests/integration/`). cdk-local's lint is
    source-only, so its "never inject into the tests tree" clause is FALSE
    here — the drift §10-c's per-repo check exists to catch.
  - **Then guard the SHAPE of the fix**, since nothing else re-checks a config
    or hook line: a unit test on the config object for a build-config change,
    or the standalone hook suite for a `.claude/hooks/` change — which §5
    notes you must run BY HAND.

  Both arms end in writing, and `vp fmt` mangles a paragraph that uses bold
  AND contains a double-star glob inside a code span — it corrupted this very
  passage when go-to-k/cdk-real-drift#1766 added it. Now a GATE:
  `tests/markdown-fmt-corruption-1771.test.ts` fails on both the trigger
  construct and the damage; write the plain directory (`src/`, `tests/`) in a
  bold paragraph. Root cause + toolchain bump: go-to-k/cdk-real-drift#1771 /
  go-to-k/cdk-real-drift#1780.

- **transport / client-config change** (`src/read/client-config.ts`
  requestHandler / agents / timeouts, proxy routing) → live-verify with ZERO
  deployed resources: `check` on an UNDEPLOYED unique-named stack still makes
  real AWS calls (STS + CloudFormation DescribeStacks) and exits 0 with "not
  deployed yet — skipped", so the transport is exercised end-to-end with
  nothing to sweep and no sentinel armed. The oracle is whatever observes the
  transport — for go-to-k/cdk-real-drift#1841 (PR go-to-k/cdk-real-drift#1852)
  a ~25-line local logging HTTP CONNECT proxy proved every call tunneled, plus
  dead-proxy, `NO_PROXY` bypass, and no-proxy control arms. Reach for the
  deploy tier below only when the change needs a real RESOURCE.
- **revert / read HOT-PATH fix** → live-verify with a MINIMAL, UNIQUE-named
  fixture: deploy → mutate out of band → `check` detects → `revert --yes`
  converges → confirm the live value. A throwaway CDK app works:
  `/tmp/<name>/app.cjs` (require-style CJS so classic module resolution works;
  **ESM `import` ignores `NODE_PATH`**), and `ln -s <repo>/node_modules
node_modules` to borrow `aws-cdk-lib` (rm any existing dir first — `ln -sfn`
  into an existing dir nests a symlink). Inline/no-asset stacks need no
  bootstrap. Build the FIX binary with `vp pack` and run
  `node "<LANE_TREE>/dist/cli.js"` — the absolute path from the launch-mode
  probe, not `.worktrees/<w>/…`, which is wrong twice: it is relative to the
  main checkout, and an IN-PLACE launch tree need not live under `.worktrees/`
  at all.

**Fresh deploys: UNIQUE hunt-style stack names only** (`Cdkrd<issue>Verify`),
never a shared fixed name and never a real prod stack — the account may hold
the maintainer's production stacks. **Tag every ephemeral deploy
`cdkrd:ephemeral=1`** (`Tags.of(app).add('cdkrd:ephemeral','1')`, or `aws
cloudformation deploy --tags cdkrd:ephemeral=1`) so the generic sweep net can
find it whatever its type.

**Cleanup is enforced, not optional.** The `deploy-autoarm-gate` hook ARMS this
session's own bughunt-clean token on any deploy command, so YOUR commit / PR is
BLOCKED until you release it — even for a throwaway `/tmp` app (a peer
session's commits are not blocked). After the live-test, run
**`/sweep-resources`**: it tears down with `delstack` (never `cdk destroy`),
sweeps the stack-EXTERNAL orphans `delstack` can't reach (auto-created
`/aws/lambda/*` + API-GW CloudWatch **IAM roles**, RETAIN resources, KMS
pending-deletion, any `cdkrd:ephemeral`-tagged type), verifies `SWEEP CLEAN`,
and releases the gate (`bughunt-track verify` + `clear`, incl. this session's
`autoarm-<session>` owner). Confirm the stacks are gone.

If you also `bughunt-track add` your live-test stacks, **scope the `add` to
this session** — `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID" … add
<stacks>` — so a parallel agent's stacks never mix into the shared main-root
owner (go-to-k/cdk-real-drift#1409): an unscoped `add` from the main checkout
shares ONE owner file, and a `clear` empties the whole file, dropping a peer's
still-pending tracking. If shared inadvertently, NEVER `clear` while it lists a
peer's stacks; release only your `autoarm-<session>` token and merge from a
worktree cwd (the merge gate scopes by committing worktree owner + your
`autoarm`, not the shared main-root owner).

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which unblock
`gh pr merge`. Docs/tooling-only PRs (no `src/**`) are EXEMPT from the
live-test — `check` + `docs` suffice.

**Your own review round is not optional because the lane already ran one, and
this repo has no ladder to fall back on.** A lane's reviewers are its children
— same brief, same framing — so they clear what the lane already believes, and
here nothing mechanical catches that: there is no multi-agent reviewer set and
no review-tier skill, and the `pr-review` entry in `.markgate.yml` is wired to
no hook. Measured on the sibling go-to-k/cdkd#2383 (which runs a reviewer
ladder this repo does not): three rounds of the LANE's own reviewers each found
the next spelling of one defect, and it took an independent orchestrator-level
round to find the last one. This repo's go-to-k/cdk-real-drift#1838 spent its
own rounds on the same class. So the depth is your own read of the whole diff
plus a round you dispatch yourself; a lane's clean round is evidence about the
lane's assumptions, not about the diff.

**Reviewer subagents spawned BY A LANE report to the MAIN session, not to the
lane that spawned them.** Completion notifications go to the top-level session,
so a lane that dispatches reviewers and then waits on their reports waits for
something that cannot arrive (measured: go-to-k/cdkd#2417 — a lane blocked ~5
minutes; the parent relayed both verdicts by hand). Pick one shape and say
which in the dispatch: the lane runs its reviewers **synchronously** (holding
its own turn until they return), or the **parent owns the review dispatch** and
relays each verdict down — the latter under §9's queued-versus-`Resuming` rule,
because a lane waiting on a review is stopped at exactly the moment the relay
is sent.

**A reviewer's scratch COPY of a worktree is not detached from git, so its
`git add -A` writes to the LIVE tree.** A linked worktree's `.git` is a FILE
holding `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the
pointer: every git command inside the copy reads and WRITES the real worktree's
index and HEAD (measured 2026-08-29 in the sibling cdkd: a read-only reviewer's
`git add -A` in a copy staged three tracked DELETIONS in the live tree, and
nothing announced it). Two lines belong in every read-only reviewer's brief:
**run no WRITING git verb** (`add` / `commit` / `restore` / `checkout` /
`stash` / `clean`) anywhere, copy included — and if you must copy, copy OUTSIDE
every repository, since deleting the `.git` file does not detach the copy, it
only makes discovery walk UPWARD; and **report the TARGET worktree's
`git status --porcelain` before AND after the round** — the pair is what makes
damage attributable (that incident surfaced only because the NEXT reviewer
volunteered "the tree went dirty mid-review, not mine"; the responsible one
repaired the index with `git restore --staged` — index only, never the working
tree). This repo's lanes live under `.worktrees/`, so the hazard is identical.

### 8-z. When a mutation probe reports NO discrimination

**First, a rule that applies BEFORE any probe runs: COMMIT the round's real
fixes, then probe.** The reason is DESTRUCTIVE: a probe's restore puts the
subject back to the bytes it held when the snapshot was TAKEN, so it reverts
anything committed NOWHERE — a lane lost 133 lines of newly written tests that
way (go-to-k/cdkd#2457); no commit, stash or reflog held them. Committing first
makes the restore lossless. `references/implement.md`'s byte-exact
`shasum`-verified restore is the OTHER half: it guarantees the subject comes
back unmangled — a promise about the snapshot's bytes, not about work the
snapshot never contained. The milder consequence is attribution: a probe
deliberately breaks the tree, so an interruption mid-probe leaves deliberate
breakage and unfinished fixes in ONE undifferentiated dirty tree (measured on
the go-to-k/cdk-real-drift#1841 lane: a subagent died at the session limit
mid-probe with 9 dirty files, and the resuming session had to read the full
diff before it could commit). With a pre-probe commit the separator is just
`git diff` — anything unstaged after a probe is the probe's.

**A probe that reports NO discrimination is a claim about the FENCE, and four
other things produce the identical output.** Ask them in order before touching
the fence. The first three and the fixture shape below each nearly cost a
working assertion in one session (2026-08-25); item 4 was added later, from a
different run:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently as "no match":
   a `perl -0pi -e` delimited by the same `|` it escapes matches nothing; a
   `sed -E`-only alternation (`\|`) is a GNU extension matching nothing on
   macOS; a `sed: bad flag` prints ABOVE the suite output and scrolls past.
   Prove it with `grep -c '<the mutated text>'` before reading the result, and
   prefer `python3` with an `assert anchor in s` — an assertion that throws is
   louder than a quoting slip that quietly matches zero.
2. **Does the case's execution path REACH the edited line?** Breaking a hook's
   branch-lookup call left its suite fully green: every case carried an
   explicit PR number, so the lookup never ran. The fix is a case that HAS to
   take that path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the confirming
   `git status` runs in that same wrong tree — "clean" and "clean somewhere
   else" print identically. Use ABSOLUTE paths and confirm by a property the
   wrong tree cannot fake (`ls -la` mtime).
4. **Did the suite RUN, or did it only print a summary?** A mutation is an
   EDIT, so it can break the FILE rather than the assertion: a parse error
   makes `vp test run` print `Tests  no tests` — a summary line that EXISTS but
   carries no digits, so a parse reading a number out of it reports the fence
   UNFENCED, indistinguishable from a genuinely weak fence. Three conditions,
   all cheap (and none replaceable by `$?` — this file's own note that an exit
   code lies in BOTH directions): the summary must contain DIGITS; the TOTAL
   must equal a BASELINE recorded before the first probe; and no file may
   report a file-level FAIL while its case failures are zero. The population
   check earns its keep — a whole file silently not loading leaves every OTHER
   file's count intact, so digits alone still read as green.

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on the producing and the consuming side,
so breaking the producing call still served the content and the case could not
fail.

Only after all five does "the fence is weak" remain as the explanation.
Deleting an assertion on the strength of an unexamined green is how a working
guard gets removed.

The original four shapes were ported from cdkd, all measured in one session
(go-to-k/cdkd#2197 / go-to-k/cdkd#2200 / go-to-k/cdkd#2198); the mechanism is
the shell and the tooling, not anything cdkd-specific. Item 4 was added on
2026-09-03 and did NOT come from that session.

**When you add a shape here, fix every place that COUNTS it — and only half of
them contain a digit that moves.** Adding item 4 touched four places, of which
exactly TWO carried a changed numeral (the "N other things" opener and the
"all N" closer); the other two kept their numeral and moved their SCOPE (the
port note narrowed to the ORIGINAL four, the session attribution to the first
three plus the fixture shape). A sweep for changed digits returns half of the
work and looks complete, which is worse than returning none.
`references/launch-mode.md` records the same failure on its IN-PLACE table — a
count written beside a list is maintained, a count written a paragraph away is
not.

**A probe that DID discriminate is void just as easily: one that changed TWO
things at once attests to neither.** Measured on go-to-k/cdkd#2612: a comment claimed
that reordering either consumer "reds four cases", and the probe behind it had
also edited the rendered line's TEXT in the same pass — so the reds belonged to
the text edit. Re-measured one mutation at a time, each alone was GREEN and
only both together red a case: the two mechanisms are mutually redundant, the
opposite of what the comment said. One mutation per probe, tree restored
byte-exact between them (`references/implement.md`), and never report a
mutation result you did not run.

**A probe result written into a SOURCE COMMENT gets the same disposition as a
number in published prose** — DELETE it (preferred), FENCE it with a test that
reads the code, or ATTRIBUTE it as a dated measurement. Nothing downstream
re-checks such a line: go-to-k/cdkd#2612's wrong claim sat in a branch comment
in source, no test could see it, and only a review round stopped it becoming a
fence a later editor would trust. What it should have stated is the invariant
the two mechanisms jointly enforce — re-derivable, so it cannot go stale.

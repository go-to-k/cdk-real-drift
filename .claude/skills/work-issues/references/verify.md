<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge

Run `/verify-pr`; nothing enforces it. Its live-test rules decide how each PR is
verified.

**Run the live test LAST, and DECLARE the tree final, in words, to whoever is
still editing it.** Any later edit under `src/**` or `tests/integration/**`,
comment-only review fixes included, voids a completed run. Have the implementer
batch remaining findings into ONE commit and report FINAL; reviewers scope the
round to the delta and hand over all findings at once.

### Which live test the diff owes

- **fold / FP / classify fix** → the harvested **corpus** case IS the live
  evidence when it is pinned by `vp test run corpus-replay` and was live-proven
  in its originating hunt. No fresh deploy; state the deferral explicitly.
- **toolchain / CI / skill fix, nothing under `src/`** → no live tier and no
  corpus, still a verification; a diff doing both owes both arms.
  - **Changes what a command DOES** (a `vite.config.ts` task, lint/typecheck
    config, `.github/workflows/ci.yml`, a `.claude/hooks/` script): run the
    command your own diff changes — the hook's own
    `.claude/hooks/<name>.test.sh`, the workflow step's command, the changed
    task — 3–5× before and after, failure direction too. `vp run check`
    format-checks `ci.yml` as text and executes no step or hook, so it is a
    probe that cannot fail.
  - **Changes PROSE only** (skill, rule, doc, this file): the CLAIMS are the
    artifact, so resolve every hook, skill, path, task and command the text
    names against this repo's files, and RUN each command it sends the next
    agent to run. `tests/skill-doc-paths.test.ts` mechanizes the path and
    issue-ref halves.
- **transport / client-config change** (`src/read/client-config.ts`
  requestHandler / agents / timeouts, proxy routing) → live-verify with ZERO
  deployed resources: `check` on an UNDEPLOYED unique-named stack still calls
  STS and CloudFormation, exits 0 "not deployed yet — skipped", and leaves
  nothing to sweep. The oracle is whatever OBSERVES the transport (a local
  logging HTTP CONNECT proxy), with dead-proxy, `NO_PROXY`-bypass and no-proxy
  control arms. Deploy only when the change needs a real RESOURCE.
- **revert / read HOT-PATH fix** → MINIMAL, UNIQUE-named fixture: deploy →
  mutate out of band → `check` detects → `revert --yes` converges → confirm the
  live value. Throwaway app at `/tmp/<name>/app.cjs`, require-style CJS since
  ESM `import` ignores `NODE_PATH`; `ln -s <repo>/node_modules node_modules`
  borrows `aws-cdk-lib`, after removing any existing dir (`ln -sfn` nests into
  one). Inline / no-asset stacks need no bootstrap. Build with `vp pack`, run
  `node "<LANE_TREE>/dist/cli.js"` using the absolute path the launch-mode probe
  printed — a relative `.worktrees/<w>/…` resolves against the main checkout.

**A fixture that establishes the fix's PRECONDITION on the happy path cannot
test the arm where the FAILING path creates it**, and every signal says pass: a
`verify.sh` that runs `record` (writing `.cdkrd/baselines/`) before mutating
never reaches the first run, where the FIRST `check` both creates the situation
and must handle it. Ask which step writes that state in the FIXTURE and which in
the REACHABLE case; if they differ, add the arm where one operation does both,
and prove it DISCRIMINATES by mutating the fix — the original arm still passes,
the new one fails.

**A `cleanup` that also runs BEFORE the run must destroy nothing the run needs**
— a `WORKDIR="$(mktemp -d …)"` computed at load time is gone before its first
write, with a bare `No such file or directory` far from the cause as the only
symptom. This repo's fixtures arm `trap cleanup EXIT` with no pre-run call; if
you add one, create such paths inside a phase and dry-run against stubs.

**A lane forbidden real-AWS RUNS still WRITES the arm; the parent runs it** —
the serialization invariant reserves the RUN, not the authoring, and read as "no
fixture either" the ban becomes a silent deferral.

### Real-AWS safety for an ephemeral deploy

**UNIQUE hunt-style stack names only** (`Cdkrd<issue>Verify`): never a shared
fixed name, never a real stack — the account may hold the maintainer's
production stacks. **Tag every ephemeral deploy `cdkrd:ephemeral=1`**
(`Tags.of(app).add('cdkrd:ephemeral','1')`, or `aws cloudformation deploy --tags
cdkrd:ephemeral=1`) so the generic sweep net finds it whatever its type.

**Cleanup is enforced.** `deploy-autoarm-gate` arms this session's bughunt-clean
token on any deploy command, blocking YOUR commit / PR until you release it, a
throwaway `/tmp` app included. After the live test run **`/sweep-resources`**:
it tears down with `delstack` (never `cdk destroy`), sweeps the stack-EXTERNAL
orphans `delstack` cannot reach (auto-created `/aws/lambda/*` and API-GW
CloudWatch **IAM roles**, RETAIN resources, KMS pending-deletion, anything
tagged `cdkrd:ephemeral`), verifies `SWEEP CLEAN` and releases the gate. Confirm
the stacks are gone.

Scope any `bughunt-track add` to this session
(`CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID" … add <stacks>`): an
unscoped add mixes your stacks into the shared main-root owner, whose file a
`clear` empties wholesale. If shared inadvertently, never `clear` while it lists
a peer's stacks — release only your `autoarm-<session>` token and merge from a
worktree cwd.

### Measuring the command arm

- **An exit code lies in EITHER direction; drive both.** `vp run check` has
  exited 134 on a clean tree with 0 errors (Vite+ stdout `EAGAIN` panic), and a
  redirect swallowing the code turns a RED tree green — fenced by
  `tests/vp-run-check-redirect-1761.test.ts`.
- **`vp pack` before reading any `vp run test` verdict in a fresh worktree, and
  re-run a red from that file before believing it**: tests spawning the built
  CLI fail deterministically without `dist/`, and can still flake singly with
  it. Once the host is loaded the failure COUNT stops discriminating — the
  discriminator is the RE-RUN SHAPE, so check `uptime`, re-run at
  `--maxWorkers=4` and in isolation; a load artifact goes green there and a real
  failure stays red.
- **A repeated `vp run <task>` DOES re-execute here** (`cache: false` in
  `vite.config.ts`); do not import a sibling's cache-hit warning.
- **Inject the failure anywhere LINTED — here that includes the tests tree.** An
  unused variable without the underscore prefix reds `vp run check` from `src/`
  AND `tests/` (`lint.ignorePatterns` excludes only `tests/integration/`).
- **Then guard the SHAPE of the fix**, since nothing else re-checks a config or
  hook line: a unit test on the config object, or the standalone hook suite,
  which §5 notes you run BY HAND.

When the arm ends in writing: `vp fmt` mangles a bold paragraph containing a
double-star glob in a code span, so write the plain directory (`src/`,
`tests/`) there; `tests/markdown-fmt-corruption-1771.test.ts` reds on both the
construct and the damage.

### When a fix round keeps producing the next round's blocker

**Twice is the signal: stop reviewing the patch and question its SHAPE.** Find
cascade blockers by executing a probe or tracing a window, never by re-reading
the diff. Name what the rounds have in COMMON, usually one structural absence —
in practice either two spellings of ONE question (name the site that OWNS it and
have every other site copy its predicate VERBATIM) or a PROXY for a question
only another component can answer (make that component REPORT; a proxy is wrong
in both directions at once). Take the NARROW fix and file the structural one.
Filing it does not stop the cascade: what ends it is making the artifact **CLAIM
LESS**, printing raw output and naming both outcomes instead of a verdict, since
a command that claims nothing cannot claim something false. Expect that to feel
like a retreat. **Fence the REMEDIATION, not just the detection** — a destroy
built from names missing a required suffix exits 0 SILENTLY with every detection
fence green. **WITHDRAWING the half that cannot be made right is legitimate**,
and the residual issue carries the MEASUREMENTS (each proxy tried, the input
that broke it, the number it produced), not just the diagnosis.

### The review round

Default **1 `pr-code-reviewer`**; add spec + test when the `src/**` diff exceeds
400 lines or 8 files; add security on credential, role-assumption or
revert-write surfaces. Reviewers run ONCE, on the FINAL sha; re-check a fix
round by MESSAGING the same reviewer, never by dispatching a fresh one. The
docs-consistency check runs once per PR, at that same sha. **Read the whole diff
yourself even after a lane's own round** — a lane's reviewers are its children,
same brief and framing, so they clear what the lane already believes.

**Reviewer subagents spawned BY A LANE report to the MAIN session**, so a lane
that dispatches and then waits is waiting for something that cannot arrive. Say
which shape in the dispatch: the lane runs them **synchronously**, holding its
turn, or the **parent dispatches** and relays each verdict down — the latter
under §9's queued-versus-`Resuming` rule, since a lane awaiting a review is
stopped exactly when the relay is sent.

**A reviewer's scratch COPY of a worktree is not detached from git: its
`git add -A` writes the LIVE tree**, because a linked worktree's `.git` is a
FILE holding `gitdir: <repo>/.git/worktrees/<name>` and `cp -R` carries the
pointer. Two lines belong in every read-only reviewer's brief: **run no WRITING
git verb** (`add` / `commit` / `restore` / `checkout` / `stash` / `clean`)
anywhere, copy included — copy OUTSIDE every repository if you must, since
deleting the `.git` file only makes discovery walk UPWARD — and **report the
target worktree's `git status --porcelain` before AND after the round**, the
pair that makes damage attributable (repair with `git restore --staged`, index
only). **When two reviewers CONTRADICT, settle it in the code YOURSELF before
forwarding either**: forwarding both hands the implementer a contradiction with
less context than you have, and forwarding the reassuring one is how a blocker
ships.

### 8-z. When a mutation probe reports NO discrimination

**COMMIT the round's real fixes before any probe.** A probe's restore puts the
subject back to the snapshot's bytes, destroying anything committed NOWHERE; no
stash or reflog holds it. It also makes attribution trivial — anything unstaged
after a probe is the probe's. `references/implement.md`'s byte-exact
`shasum`-verified restore is the other half.

**NO discrimination is a claim about the FENCE, and five other things produce
the identical output.** Ask them first:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently as "no match" (a
   `perl -0pi -e` delimited by the same `|` it escapes, a `sed -E`-only
   alternation, a `sed: bad flag` scrolled past above the suite output). Prove
   it with `grep -c '<the mutated text>'`, or use `python3` with an
   `assert anchor in s`.
2. **Does the case's path REACH the edited line?** Breaking a hook's
   branch-lookup left its suite green because every case carried an explicit PR
   number. The fix is a case that HAS to take that path, not a weaker fence.
3. **Did the command run where you think?** A relative-path edit under a reset
   cwd lands in another worktree, and the confirming `git status` runs in that
   same wrong tree: "clean" and "clean somewhere else" print identically. Use
   ABSOLUTE paths; confirm by what the wrong tree cannot fake (`ls -la` mtime).
4. **Did the suite RUN, or only print a summary?** A mutation can break the FILE
   rather than the assertion, and a parse error prints a summary with no digits
   that reads as UNFENCED. Three cheap conditions, none replaceable by `$?`: the
   summary carries DIGITS, the TOTAL equals a BASELINE taken before the first
   probe, and no file reports a file-level FAIL with zero case failures (one
   file not loading leaves every other count intact).
5. **Is the expected value INDEPENDENT of the one under test?** A stub keyed its
   content on a sha defaulting to the same literal on the producing and the
   consuming side, so breaking the producing call still served the content
   (`references/implement.md`).

Only then does "the fence is weak" remain; deleting an assertion on an
unexamined green is how a working guard gets removed. **When you add a shape
here, fix every place that COUNTS it — only some carry a digit that moves**, so
a sweep for changed numerals returns half the work looking finished.

**A probe that DID discriminate is void just as easily: one that changed TWO
things attests to neither.** One mutation per probe, tree restored byte-exact
between them, and never report a mutation result you did not run. **A probe
result in a SOURCE COMMENT gets a published number's disposition** — DELETE it
(preferred), FENCE it with a test that reads the code, or ATTRIBUTE it as a
dated measurement, since nothing downstream re-checks such a line. Better, state
the invariant the mechanisms jointly enforce: re-derivable, so it cannot go
stale.

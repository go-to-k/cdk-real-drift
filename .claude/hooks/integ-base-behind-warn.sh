#!/usr/bin/env bash
# integ-base-behind-warn.sh — PreToolUse hook (matcher: Bash), NON-BLOCKING.
#
# Warns, before a real-AWS integration fixture is spent, that the branch is
# behind `origin/main`.
#
# NOT THE SAME THING AS stale-base-gate.sh, and the names are kept far apart on
# purpose. Read this paragraph before touching either:
#
#   stale-base-gate.sh  BLOCKS `git push`. It fires when `origin/main` is
#                       already an ANCESTOR of HEAD (the branch claims to be
#                       current) yet the branch's net diff REVERTS files recent
#                       main commits changed -- the soft-reset clobber that
#                       silently rolls back somebody else's merged PR. It is a
#                       safety boundary, at push time, about CONTENT.
#
#   this file           WARNS on stderr before an integ fixture runs. It fires
#                       on the OPPOSITE condition -- `origin/main` is NOT an
#                       ancestor of HEAD, i.e. the branch is BEHIND -- and it is
#                       a discipline aid, at run time, about the BASE the run is
#                       spent on. It never blocks anything.
#
# The two conditions are mutually exclusive by construction: stale-base-gate
# opens with `git merge-base --is-ancestor "$base" HEAD || exit 0` and this hook
# exits when `git rev-list --count HEAD..origin/main` is 0. Do not merge, rename
# or fold them together.
#
# WHY THIS ONE EXISTS
#
# An integ run here is expensive in a way a unit test is not: each fixture's
# `verify.sh` rebuilds the CLI (`cd "$ROOT" && vp run build`), then runs
# `npx cdk deploy` into a real account in `us-east-1`, records a baseline,
# checks, injects drift, checks again, and tears the stack down through
# `delstack`. Minutes of wall clock, real resources, and a cleanup sentinel that
# blocks every commit until the account sweeps clean. Spending that on a tree
# `main` has already moved past buys a result about the wrong tree -- the binary
# under test is built from this branch, and every `src/**` change that landed on
# `main` in the meantime is simply absent from it.
#
# THE MARKER HALF IS CONDITIONAL HERE, AND SAYING SO IS THE POINT.
#
# In cdkd, this hook's ancestor exists because a rebase after the run moves the
# merge base and stales the `hash: diff` integ marker the run was spent to earn
# -- measured 2026-09-04 (go-to-k/cdkd#2589): six review rounds ran over ~2 h,
# `main` advanced during them, the rebase moved the merge base past a merged PR
# touching in-scope files, `markgate verify` went `mismatch`, and a fixture was
# re-run against real AWS to re-earn it.
#
# That mechanism is only LATENT in this repo. `.markgate.yml` declares an
# `integ` gate -- singular; there is no destroy / broad / local /
# schema-migration split here, because cdkrd is read-only against AWS -- with
# `hash: diff`, `base: origin/main`, `ttl: 14d` and
# `include: ['src/**', 'tests/integration/**']`. But that gate is deliberately
# INERT: nothing calls `markgate set integ` (there is no `/run-integ` companion
# skill), and no hook consults it, exactly so it cannot brick the flow. So today
# the cost this hook names is the RUN, not a marker; if and when the `integ`
# gate is wired, the marker cost lands on top with no change to this hook,
# because the scope regex below is derived from that gate's `include`.
#
# WHY HERE AND NOT AT `markgate set`
#
# The obvious placement is next to the marker write, and it is the wrong one: by
# then the AWS run is already spent, so the warning can only tell you the money
# is gone. This hook fires on the fixture INVOCATION, which is the last moment a
# rebase is still free.
#
# WHY NON-BLOCKING
#
# A deliberate run on an older base is legitimate (bisecting a regression,
# reproducing an issue against a released tree, re-running a fixture exactly as
# a filed issue describes it), and a hard refusal there would cost more than the
# waste it prevents. It exits 0 always, and its only effect is text on stderr.
#
# NOISE CONTROL
#
# Only fires for a command that actually runs a fixture or deploys. Read verbs
# (`grep` / `cat` / `ls` / `git diff|log|show|add|status` / `echo` / `sed -n`)
# exit immediately, in command position ANYWHERE in the command rather than only
# at its start -- anchoring at `^` alone leaves `git diff .../verify.sh`,
# `cd x && cat .../verify.sh` and a heredoc body warning, which is how a warn
# hook trains people to ignore it.
#
# The fixture-script needle is `verify[A-Za-z0-9_-]*\.sh`, with NO dot allowed
# in the stem, and that is load-bearing rather than tidy: it matches all 53
# documented scripts (`verify.sh`, `verify-detect.sh`, `verify-harvest12.sh`,
# `verify-mutation-matrix.sh`, ...) while NOT matching this repo's own hook
# harnesses -- `.claude/hooks/verify-pr-gate.test.sh` fails it at `.test.sh`.
# Warning on `vp run test:hooks`'s own suite would be pure noise.
#
# A fixture path inside an arbitrary quoted string is still a KNOWN false
# positive: this hook does not parse quoting, and since it only prints to stderr
# the cost is a stray note, not a block.

set -u

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# The invocation shapes this repo actually uses, from tests/integration/README.md
# and the `# Usage:` header every fixture script carries:
#
#   cd tests/integration/<name> && npm install && bash verify.sh
#   cd basic && bash verify-mutation-matrix.sh
#   bash tests/integration/<name>/verify.sh          (works; undocumented)
#
# plus the raw deploy the scripts themselves run, which an agent also types by
# hand when reproducing a fixture step:
#
#   npx cdk deploy -f "$STACK" --require-approval never
#
# `node dist/cli.js check|record|ignore|revert` is deliberately NOT armed: those
# four verbs are read-mostly, run constantly, and the two that write touch a
# committed baseline file rather than AWS. Arming on them would fire on ordinary
# development.
printf '%s' "$cmd" | grep -qE '(bash|sh)[[:space:]]+[^|;&]*verify[A-Za-z0-9_-]*\.sh|tests/integration/[^[:space:]]*/verify[A-Za-z0-9_-]*\.sh|(^|[|;&]|&&)[[:space:]]*(npx[[:space:]]+)?cdk[[:space:]]+deploy([[:space:]]|$)' || exit 0

# Reading a fixture is not running one. ONE read-verb test, in command position
# anywhere.
printf '%s' "$cmd" | grep -qE '(^|[|;&]|&&)[[:space:]]*(grep|rg|cat|less|head|tail|ls|wc|echo|sed[[:space:]]+-n|git[[:space:]]+(diff|log|show|add|status))[[:space:]]' && exit 0

cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cwd" ] || cwd=$PWD
[ -d "$cwd" ] || exit 0

# Opt-in: only in a repo that uses markgate, matching issue-dup-check-gate.sh's
# convention. A fixture-shaped command run in some unrelated checkout is not
# this repo's business.
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$top" ] || exit 0
[ -f "$top/.markgate.yml" ] || exit 0

# NO `git fetch` here. A PreToolUse hook runs on every matching Bash call and
# must stay fast and side-effect-free; a fetch would add network latency to the
# critical path and mutate refs behind the user. The trade is that this reads
# the LAST-FETCHED `origin/main`, so it under-reports when the local ref is
# itself stale -- under-reporting is the safe direction for a non-blocking
# nudge.
git -C "$cwd" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

behind=$(git -C "$cwd" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
case "$behind" in ''|*[!0-9]*) exit 0 ;; esac
[ "$behind" -gt 0 ] || exit 0

branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
[ -n "$branch" ] || branch='(detached HEAD)'

# In-scope FILES are what make this expensive rather than merely untidy: a
# doc-only advance on main will not change what the fixture exercises. Naming
# them turns a generic nudge into a judgement the reader can make.
#
# DERIVED FROM `.markgate.yml`'s `integ` gate include (`src/**` +
# `tests/integration/**`), not from the sibling repo's list -- cdkd's regex
# names providers / destroy-runner / deploy-engine paths, none of which exist
# here. If that include changes, change this line with it.
#
# This counts FILES, not commits, and the message says so.
scope_re='^src/|^tests/integration/'
in_scope=$(git -C "$cwd" diff --name-only HEAD...origin/main 2>/dev/null | grep -cE "$scope_re" || true)
case "$in_scope" in ''|*[!0-9]*) in_scope=0 ;; esac

{
  echo "NOTE integ-base-behind-warn: '$branch' is $behind commit(s) behind origin/main."
  if [ "$in_scope" -gt 0 ]; then
    echo "  $in_scope in-scope file(s) arrive with them (src/** or tests/integration/**)."
    echo "  The CLI this fixture builds and deploys will NOT contain them, so a"
    echo "  clean result says nothing about the tree you are about to merge into."
    echo "  Rebase onto origin/main FIRST, then run this once -- an integ here is"
    echo "  a real deploy + destroy in us-east-1, not a unit test."
  else
    echo "  None of them touch src/** or tests/integration/**, so the run itself"
    echo "  should still be representative -- but the built binary is from an"
    echo "  older base."
  fi
  echo "  A rebase AFTER the run also moves the merge base, which would stale a"
  echo "  \`hash: diff\` marker for the \`integ\` gate in .markgate.yml (same"
  echo "  include as the scope above). That gate is currently INERT here -- no"
  echo "  companion skill sets it and no hook reads it -- so today the cost is"
  echo "  the AWS run alone."
  echo "  Rules: CLAUDE.md -> the worktree recipe (base on \`origin/main\`, not"
  echo "  local \`main\`); tests/integration/README.md."
  echo "  Deliberately running against an older base (a bisect, a repro)? Ignore this."
} >&2

exit 0

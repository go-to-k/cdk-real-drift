#!/usr/bin/env bash
# ci-green-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` unless the target PR's CI checks are
# ALL green. Motivated by a real incident: an agent merged a PR whose
# `check-build-test` job was red (a formatting violation), landing broken state
# on main. `main` has NO branch protection — and adding GitHub required status
# checks is not an option here, because semantic-release pushes the
# `chore(release): x.y.z [skip ci]` commit DIRECTLY to main (not via PR); a
# required-status-check rule would permanently block that release push (the
# [skip ci] commit never gets a green check). So the merge gate lives here, in a
# local hook that only touches `gh pr merge` and leaves the release push
# untouched.
#
# Behavior:
#   - Only `gh pr merge` is gated (create/edit pass — CI has not run yet at
#     create time). Line-start anchored so the substring inside a quoted arg
#     body does not false-positive (mirrors verify-pr-gate.sh).
#   - `gh pr checks <pr>` is run for the resolved PR (explicit number/URL/branch
#     arg, else the current branch's PR). Exit 0 = all passing; any non-zero
#     (a failing check OR a still-pending run) blocks — a red or in-flight CI
#     must never be merged.
#   - Human emergency override: an explicit `--admin` flag bypasses the gate
#     (the maintainer consciously force-merging). The agent must NOT add
#     `--admin` on its own to get past a red CI.
#   - Fails OPEN when it cannot audit (no gh, not a git repo, PR/checks not
#     resolvable) — it only blocks when it can PROVE the CI is not green.
#
# cwd-aware target resolution mirrors verify-pr-gate.sh (worktree flow: cwd +
# leading `cd <path>` + last `gh -C <path>`).

set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (with optional leading `cd <path> &&` and optional
# `gh -C <path>`). Anything else passes through.
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r … ] || exit 0` was the
# first shape here, and it silently disabled the gate whenever the library was
# unreadable or truncated — with the sibling gates' own comments claiming the
# opposite (go-to-k/cdkd#2130 review). The `declare -F` check catches a partial
# source, where `.` succeeds but the function is missing.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi

# Which commands this gate applies to. The segment matcher sees a gated verb
# in ANY position — `git add -A && git commit` used to run ungated
# (go-to-k/cdk-real-drift#1803).
GATE_RE="$GATE_RE_GH_PR_MERGE"
gate_matches "$cmd" "$GATE_RE" || exit 0

# Human emergency override.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])--admin([[:space:]]|=|$)'; then
  echo "ci-green-gate: --admin present — maintainer override, skipping CI check." >&2
  exit 0
fi

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE")

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi
cd "$target_dir" 2>/dev/null || exit 0

# gh is required to check; if absent we cannot audit — pass.
command -v gh >/dev/null 2>&1 || exit 0

# Extract the first non-flag token after `pr merge` as the PR selector
# (number / URL / branch). Empty => gh resolves the current branch's PR.
#
# ANCHORED ON `pr merge`, NOT ON `gh` PLUS A FLAG PREFIX. The previous form led
# with `.*gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?`, so any global flag other
# than `-C` made the whole substitution fail to apply -- and the awk fallback then
# returned the first non-flag token of the UNTOUCHED command, which is the literal
# string `gh`:
#
#   gh pr merge 1 --squash                 -> prsel=1
#   gh -R go-to-k/x pr merge 1 --squash    -> prsel=gh     <-- wrong
#   gh -Rgo-to-k/x pr merge 7 --squash     -> prsel=gh     <-- wrong
#
# That is not a cosmetic mis-parse, it is the SAME BYPASS arriving one step later.
# `gh pr checks gh` prints `no pull requests found for branch "gh"` (measured
# against gh 2.89.0), which this gate's fail-open grep below treats as "no CI to
# check" and PASSES. So widening `GATE_GH_C` made the gate fire on
# `gh -R o/r pr merge` and it still exited 0 in any repo with a remote. The parity
# harness did not catch it because its fixture had no remote, so `gh` failed with
# a different message -- the fixture could not contain the feature under test.
# Its `gh` stub now answers a non-numeric selector with the real fail-open
# wording, so this arm is fenced.
prsel=""
if [[ "$cmd" =~ (^|[[:space:]])pr[[:space:]]+merge([[:space:]]+([^-][^[:space:]]*))? ]]; then
  prsel="${BASH_REMATCH[3]}"
fi

checks_out=$(gh pr checks $prsel 2>&1)
rc=$?

# rc 0 = every check passed. Non-zero = a failing check (rc 1) or still-pending
# runs (rc 8) — block either way. If gh could not find a PR / checks at all it
# typically prints "no ... checks" — treat an inability to resolve as fail-open
# (pass) so a legitimately check-free PR is not wedged.
if [ "$rc" -eq 0 ]; then
  exit 0
fi
if printf '%s' "$checks_out" | grep -qiE 'no checks reported|no pull requests found|no open pull request'; then
  exit 0
fi

printf 'Blocked by ci-green-gate: the PR%s CI is not all-green.\n\n' \
  "${prsel:+ ($prsel)}" >&2
printf '%s\n\n' "$checks_out" >&2
cat >&2 <<'EOF'
A red or still-pending CI must not be merged (this is exactly the incident this
gate exists to prevent). Required action:
  - Wait for the checks to finish and turn green, then merge again, OR
  - fix the failing check and push, then merge once CI is green.

Maintainer emergency override (human, conscious force-merge of a red PR):
  gh pr merge <pr> --squash --admin
The agent must NOT add --admin to get past a red CI on its own.
EOF
exit 2

#!/usr/bin/env bash
# ci-green-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` unless the target PR's CI checks are
# ALL green. Motivated by a real incident: an agent merged a PR whose
# `check-build-test` job was red (a formatting violation), landing broken state
# on main. `main` has NO branch protection — the constraint dates from
# semantic-release (the release automation of the time), which pushed the
# `chore(release): x.y.z [skip ci]` commit DIRECTLY to main (not via PR), so a
# required-status-check rule would have permanently blocked that release push.
# release-please now lands release commits via its release PR instead, but main
# still has no branch protection, so the merge gate stays here, in a local hook
# that only touches `gh pr merge`.
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

# A FOREIGN `-R` is refused rather than audited. Every probe below runs against
# the RESOLVED CWD, so `gh -R foreign/repo pr merge` would have this gate inspect
# THIS repo's state and then permit an action in a repo it never looked at. `-R`
# was matched by the flag absorber and then discarded.
foreign_repo=$(gate_foreign_repo "$cmd" "$GATE_RE" "$target_dir")
if [ -n "$foreign_repo" ]; then
  {
    echo "Blocked by ci-green-gate: this command targets \`$foreign_repo\`, but every"
    echo "check this gate makes reads the repository at:"
    echo ""
    echo "  $target_dir"
    echo ""
    echo "so passing it would mean approving an action in a repo that was never"
    echo "inspected. Run the command from a checkout of \`$foreign_repo\` instead,"
    echo "where that repo's own gates apply."
  } >&2
  exit 2
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi
cd "$target_dir" 2>/dev/null || exit 0

# gh is required to check; if absent we cannot audit — pass.
command -v gh >/dev/null 2>&1 || exit 0

# The PR selector: the first non-flag token after the MATCHED verb, from the
# MATCHED SEGMENT. Empty => gh resolves the current branch's PR.
#
# Two defects lived here, and the second was introduced by the fix for the first
# (both measured 2026-08-25):
#
#   - a literal `.*gh( -C <p>)? pr merge` strip, which any other global flag made
#     fail to apply, so the awk fallback returned the command name `gh`. And
#     `gh pr checks gh` prints `no pull requests found for branch "gh"`, which the
#     fail-open grep below reads as "no CI to check" and PASSES.
#   - its replacement anchored the selector IMMEDIATELY after the verb, so a
#     flag-first spelling lost it -- `gh pr merge --squash 1` gave an empty
#     selector, a red-CI bypass that did NOT exist before that change:
#
#       gh pr merge 1 --squash          rc=2
#       gh pr merge --squash 1          rc=0   <- regression
#       gh -R o/r pr merge --squash 1   rc=0   <- regression
#
# `gate_pr_selector` consumes flag VALUES (not merely skipping tokens that start
# with `-`, which made `-t msg 2195` resolve `msg`), applies a numeric guard, and
# reads only the matching segment, so a quoted `gh pr merge 9` in a --body cannot
# donate its number to a later bare `gh pr merge`. Fenced in
# _command-match.test.sh and by this gate's own harness, whose stub answers PER
# SELECTOR.
prsel=$(gate_pr_selector "$cmd" "$GATE_RE")
# A SECOND, INDEPENDENT shape guard, mirroring non-english-text-gate's. Two
# guards beat one here specifically: this is the gate whose fail-open arm turns a
# bad selector into a merge past red CI — `gh pr checks <not-a-pr>` prints
# `no pull requests found for branch "…"`, which the grep below reads as "no CI
# to check". `gate_pr_selector` already refuses a non-numeric token; if a future
# change relaxes that, this keeps the damage to a fall-back rather than a wrong
# PR.
case "$prsel" in
  ''|*[!0-9]*) prsel="" ;;
esac

# AN EMPTY SELECTOR IS NOT AUTOMATICALLY SAFE HERE, and the flag-list comment in
# _command-match.sh used to claim it was. Measured: with the short forms missing
# from the valueless list, `gh pr merge -s 2195` lost its number, this gate ran
# `gh pr checks` with NO argument, nothing resolved, the output matched the
# `no pull requests found` fail-open below, and the merge PASSED past red CI.
#
# So distinguish the two ways a selector can be absent. `gh pr merge --squash`
# gives no selector at all -- a legitimate current-branch merge, and the
# no-argument fallback is right for it. `gh pr merge --future-flag 552` DID give
# one and a flag swallowed it; resolving the current branch there audits a PR the
# user never named. Only the second is refused, so the fallback keeps working for
# the case it exists for.
if [ -z "$prsel" ] && gate_pr_selector_ate_number "$cmd" "$GATE_RE"; then
  {
    echo "Blocked by ci-green-gate: a flag in this command swallowed the PR number,"
    echo "so the gate cannot tell which PR's CI to check."
    echo ""
    echo "This happens when a flag that TAKES a value is not in the gate's"
    echo "valueless-flag list, or when a flag genuinely takes a value and the PR"
    echo "number follows it. Falling back to the current branch here would audit a"
    echo "PR you did not name, and a PR that does not resolve at all reads as"
    echo "\"no CI to check\" -- which is how a red CI once merged."
    echo ""
    echo "Put the PR number where it cannot be eaten:"
    echo ""
    echo "  gh pr merge <number> --squash --delete-branch"
    echo ""
    echo "If the flag really is valueless, add BOTH its spellings to"
    echo "GATE_GH_PR_VALUELESS_FLAGS in .claude/hooks/_command-match.sh."
  } >&2
  exit 2
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

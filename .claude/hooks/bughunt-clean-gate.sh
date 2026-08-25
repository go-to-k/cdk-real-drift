#!/usr/bin/env bash
# bughunt-clean-gate.sh
#
# PreToolUse hook. Blocks `git commit`, `gh pr create`, and `gh pr merge` while a
# /hunt-bugs session still has un-deleted AWS resources tracked in the sentinel
# `.markgate-bughunt-pending` (at the shared main-tree root).
#
# WHY: /hunt-bugs deploys real AWS stacks to find latent cdkrd bugs. The one
# unacceptable outcome is forgetting to delete them. Rather than trust the operator
# to remember, the skill records every deployed stack in the sentinel via
# `bughunt-track.sh add`, and this gate makes it physically impossible to land any
# commit / PR until `bughunt-track.sh clear` empties the sentinel — which the skill
# runs ONLY after delete + orphan-zero verification. The rule says "always delete
# bug-hunt resources"; this hook enforces it.
#
# The sentinel dir is resolved at the SHARED main-tree root (via --git-common-dir) so
# the deploy-time tracker and this gate — which may run from different worktrees —
# agree on one location.
#
# PER-OWNER scoping: the block is decided against the COMMITTING owner ONLY, not the
# repo-wide aggregate. Bug-hunt stacks are uniquely named, so one session's live hunt
# creates no resource contention for an unrelated session's clean commit — blocking
# it would be pure friction. Each owner (a worktree, or an explicit
# $CDKRD_BUGHUNT_OWNER) tracks its own file under `.markgate-bughunt-pending.d/<key>`,
# and this gate blocks a `git commit` / `gh pr create` / `gh pr merge` only while the
# owner that RUNS it still has un-deleted stacks — enforcing cleanup per-worktree
# (the owner stays blocked in ITS own worktree until it clears) without over-blocking
# peers. The owner key mirrors bughunt-track.sh exactly ($CDKRD_BUGHUNT_OWNER, else
# the committing worktree's toplevel path, sanitized). The legacy flat sentinel
# `.markgate-bughunt-pending` remains a GLOBAL block for back-compat (a session armed
# before the per-owner port, or a stray hand-written file).

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

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

# Gate only `git commit`, `gh pr create` and `gh pr merge`. The shared segment
# matcher sees the verb in ANY position — `git add -A && git commit` used to run
# ungated (go-to-k/cdk-real-drift#1803) — while a mention inside a quoted argument
# body still does not count. Not because quoted spans are BLANKED -- that was an
# early shape, reverted because it also erased the PATH in `cd "<worktree>" &&
# git commit` (go-to-k/cdk-local#542). Segments keep their original text; only the
# separator CHARACTERS inside quotes are swapped for placeholders while splitting,
# and a verb inside a string still fails to match because each verb regex is
# anchored at the segment START.
# DERIVED from the shared constants, never hand-rolled — see verify-pr-gate.sh
# for the `-R` bypass this closes (here it let a merge through with live AWS
# resources still standing).
GATE_RE_COMMIT_OR_PR=$(gate_re_any "$GATE_RE_GIT_COMMIT" "$GATE_RE_GH_PR_CREATE" "$GATE_RE_GH_PR_MERGE")

# NO foreign-`-R` refusal here, deliberately, and recorded because this is the
# fourth gate on `gh pr merge` and the omission would otherwise read as an
# oversight. The other three refuse a foreign `-R` because they audit
# REPO-SPECIFIC state (this repo's markers, this repo's CI, this repo's diff) and
# would otherwise approve an action in a repo they never inspected. This gate
# asks a SESSION-LOCAL question — does the committing owner still have bug-hunt
# stacks standing in AWS — whose answer does not depend on which repository the
# PR lives in. Refusing a foreign `-R` here would add friction and protect
# nothing.
gate_matches "$cmd" "$GATE_RE_COMMIT_OR_PR" || exit 0

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_COMMIT_OR_PR")

# Not a git repo (or git unavailable) → nothing to gate.
git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Resolve the shared main-tree root (parent of the common .git dir) so the sentinel
# is the same path regardless of which worktree this runs in.
git_common="$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$git_common" ]; then
  main_root="$(dirname "$git_common")"
else
  main_root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "$target_dir")"
fi
# Per-owner block: a commit/PR is gated only by the identities that RUN it, so a peer
# session's live hunt never blocks it. Two owner identities are checked:
#   1. the committing worktree owner — mirror bughunt-track.sh ($CDKRD_BUGHUNT_OWNER if
#      exported, else the committing worktree's toplevel path), the per-STACK tracking.
#   2. this SESSION's deploy-autoarm token "autoarm-<session>" — deploy-autoarm-gate arms
#      it on any deploy; the session id is $CLAUDE_CODE_SESSION_ID (or the payload's
#      session_id), the SAME value that hook and /sweep-resources use.
# The legacy flat file stays a GLOBAL block for back-compat.
pending_dir="${main_root}/.markgate-bughunt-pending.d"
legacy="${main_root}/.markgate-bughunt-pending"

owner_raw="${CDKRD_BUGHUNT_OWNER:-}"
if [ -z "$owner_raw" ]; then
  owner_raw="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "$target_dir")"
fi
owner_key="$(printf '%s' "$owner_raw" | sed 's#[^A-Za-z0-9._-]#_#g')"
owner_file="${pending_dir}/${owner_key}"

sid="${CLAUDE_CODE_SESSION_ID:-}"
[ -z "$sid" ] && sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || echo "")
sid_key="$(printf '%s' "$sid" | sed 's#[^A-Za-z0-9._-]#_#g')"
autoarm_file="${pending_dir}/autoarm-${sid_key:-shared}"

sources=()
[ -s "$owner_file" ] && sources+=("$owner_file")
[ -s "$autoarm_file" ] && sources+=("$autoarm_file")
[ -s "$legacy" ] && sources+=("$legacy")

# None of this owner/session's files (nor the legacy flat file) have content → pass.
[ "${#sources[@]}" -gt 0 ] || exit 0

pending=$(cat "${sources[@]}" 2>/dev/null | grep -cvE '^[[:space:]]*$' || echo 0)
[ "$pending" -gt 0 ] || exit 0

{
  echo "Blocked by bughunt-clean-gate: THIS session/owner still has ${pending}"
  echo "un-deleted bug-hunt stack(s)/deploy(s) tracked under:"
  [ -s "$owner_file" ] && echo "  ${owner_file} (worktree owner)"
  [ -s "$autoarm_file" ] && echo "  ${autoarm_file} (this session's deploy-autoarm token)"
  [ -s "$legacy" ] && echo "  ${legacy} (legacy global sentinel)"
  echo
  echo "Pending stacks:"
  cat "${sources[@]}" 2>/dev/null | grep -vE '^[[:space:]]*$' | sed 's/^/  - /'
  echo
  echo "Required action — delete every tracked stack, verify zero orphans, then release:"
  echo "  /sweep-resources          # discovers + deletes cdkrd test resources, then clears"
  echo "  # or manually, per owner shown above (verify + clear as separate commands):"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh verify --region <region>"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh clear"
  echo
  echo "Do NOT delete the pending files by hand to bypass this — the whole point is"
  echo "that bug-hunt resources cannot be forgotten. Clear only after the"
  echo "delete + orphan-zero verification actually passed."
} >&2
exit 2

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
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Human emergency override.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])--admin([[:space:]]|=|$)'; then
  echo "ci-green-gate: --admin present — maintainer override, skipping CI check." >&2
  exit 0
fi

# Resolve where the gh command will actually run (cwd + leading cd + gh -C).
target_dir="${hook_cwd:-$PWD}"

if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

if [[ "$cmd" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

# Can't audit what we can't see — pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi
cd "$target_dir" 2>/dev/null || exit 0

# gh is required to check; if absent we cannot audit — pass.
command -v gh >/dev/null 2>&1 || exit 0

# Extract the first non-flag token after `pr merge` as the PR selector
# (number / URL / branch). Empty => gh resolves the current branch's PR.
prsel=$(printf '%s' "$cmd" \
  | sed -E 's/.*gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge//' \
  | awk '{ for (i = 1; i <= NF; i++) { if (substr($i,1,1) != "-") { print $i; exit } } }')

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

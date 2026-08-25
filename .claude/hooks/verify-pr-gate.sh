#!/usr/bin/env bash
# verify-pr-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` and `gh pr merge` (including
# --auto) unless the `verify-pr` markgate marker is fresh for the
# current content state. The gate's scope (see .markgate.yml) covers
# every code/test/doc path the /verify-pr skill inspects, so editing
# any of them invalidates the marker and forces a successful
# /verify-pr run before the PR can be opened or merged.
#
# This is the structural enforcement of the "PR readiness checklist"
# rule: live-test the changed behavior, walk all shared-utility
# callers, refresh PR title + body, and run the session retrospective
# (proposing new rules/hooks/skills for recurring patterns) BEFORE
# `gh pr create` / `gh pr merge`. The skill said it; the hook
# enforces it.
#
# WHY the cwd-aware resolution matters (cdkd #559): this repo is
# regularly worked in via `git worktree`, and markgate stores marker
# state per-worktree at `<git rev-parse --absolute-git-dir>/markgate/`.
# The pre-#559 implementation derived REPO from `BASH_SOURCE` and
# always landed on the main working tree, defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's view (see memory rule
# feedback_cross_agent_main_tree_contention.md). We now resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# leading `cd <path>` + last `gh -C <path>` flag.

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and `gh pr merge` invocations -- any other
# command passes through. Match both `gh pr merge` and
# `gh pr merge --auto`. Tolerate an optional `gh -C <path>` between
# `gh` and `pr` so `gh -C <path> pr create` is also recognised.
# Line-start anchored (per memory rule
# feedback_hook_command_match_line_start.md) so `gh pr create` /
# `gh pr merge` substrings inside quoted argument bodies
# (`echo "next step: gh pr create"`) do NOT false-positive into a
# hard block. The optional leading `cd <path> &&` prefix preserves
# the worktree-aware `cd <side> && gh pr create` chain shape,
# mirroring check-gate.sh (PR #562 fix pattern).
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

# Which commands this gate applies to. The segment matcher sees a gated verb in
# ANY position — `git add -A && git commit` used to run ungated
# (go-to-k/cdk-real-drift#1803).
# DERIVED from the shared constants, never hand-rolled. The local copy this
# replaces absorbed only `-C <path>`, so `gh -R <owner/repo> pr merge 1 --squash`
# matched nothing and merged past this gate while the same command without `-R`
# was refused (measured 2026-08-25: plain rc=2, `-R` rc=0). A hand-rolled copy
# also does not inherit a widening of `GATE_GH_C`, which is how it drifted.
GATE_RE_PR_CREATE_OR_MERGE=$(gate_re_any "$GATE_RE_GH_PR_CREATE" "$GATE_RE_GH_PR_MERGE")
gate_matches "$cmd" "$GATE_RE_PR_CREATE_OR_MERGE" || exit 0

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_PR_CREATE_OR_MERGE")

# A FOREIGN `-R` is refused rather than audited. Every probe below runs against
# the RESOLVED CWD, so `gh -R foreign/repo pr merge` would have this gate inspect
# THIS repo's state and then permit an action in a repo it never looked at. `-R`
# was matched by the flag absorber and then discarded.
foreign_repo=$(gate_foreign_repo "$cmd" "$GATE_RE_PR_CREATE_OR_MERGE" "$target_dir")
if [ -n "$foreign_repo" ]; then
  {
    echo "Blocked by verify-pr-gate: this command targets \`$foreign_repo\`, but every"
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


# Fails CLOSED (keeps gating) if the changed-file set can't be computed — we
# only skip the gate when we can PROVE the diff is src-free.
#
# Read the diff from the RESOLVED TARGET DIR, never the hook's own cwd. The hook
# process runs wherever the client launched it (usually the main checkout), where
# HEAD == origin/main and the diff is EMPTY, so the exemption could not fire and
# a docs-only PR was told to run /verify-pr. The mirror case is worse: a cwd
# sitting in some OTHER tree with a non-src diff would have EXEMPTED a PR that
# does touch `src/**` — a fail-open. Measured 2026-08-21 while merging
# go-to-k/cdk-real-drift#1805.
base=""
for ref in origin/main origin/master main master; do
  if git -C "$target_dir" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then base="$ref"; break; fi
done
if [ -n "$base" ]; then
  mb=$(git -C "$target_dir" merge-base "$base" HEAD 2>/dev/null || echo "")
  if [ -n "$mb" ]; then
    changed=$(git -C "$target_dir" diff --name-only "$mb" HEAD 2>/dev/null || echo "__ERR__")
    if [ "$changed" != "__ERR__" ] && [ -n "$changed" ] \
       && ! printf '%s\n' "$changed" | grep -qE '^src/'; then
      echo "verify-pr-gate: PR diff touches no src/** (docs/tooling-only) — exempt from /verify-pr (check + docs cover it)." >&2
      exit 0
    fi
  fi
fi


# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Non-src exemption: /verify-pr's heavy half (live-test changed behavior +
# real-AWS integration fixtures + retrospective) only earns its cost when the
# change carries RUNTIME BEHAVIOR — i.e. touches `src/**`. A PR that edits only
# docs, tooling (.claude/**, .github/**, .mise.toml), or integ teardown scripts
# has no behavior to live-test; the `check` + `docs` markers (enforced at commit
# by check-gate) already cover its quality. Demanding a full /verify-pr there
# (which needs AWS credentials it doesn't exercise) is pure friction. So: if the
# PR's diff vs the base contains NO `src/**` path, let it through.
#
# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary; see check-gate.sh for
# the schema-bump rationale (0.3.0 markers are silently invisible to 0.3.1).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by verify-pr-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify verify-pr >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status verify-pr` so the
# error message tells the user *why* the gate is stale. With markgate 0.3+
# `requires: [check, docs]` the reason often names the failing child
# (e.g. "(child docs is stale)"), pointing the user straight at /check or
# /check-docs without forcing them to re-run /verify-pr blindly. Fails open
# to the static heredoc body when extraction fails.
reason=$("${markgate[@]}" status verify-pr 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale %s.\n\n" "$reason" >&2
else
  echo "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale (or missing)." >&2
  echo >&2
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /verify-pr [PR-number]

The skill walks the full PR-readiness checklist:
  - typecheck / lint / build / unit tests
  - test coverage for the diff
  - CI status / working tree / docs consistency / leftover AWS resources
  - code review (incl. shared-utility caller verification)
  - live-test the changed behavior against real or fixture input
  - retrospective + proposals for new rules / hooks / skills
  - PR title + body freshness vs the actual diff

Not heavyweight for a doc-like src change: this gate intentionally keys on
ANY src/** edit (the exemption above is all-or-nothing — a finer
"behavior-free" heuristic can't be proven fail-safe, so it is not attempted).
But when the src change is confined to --help / --version text or code
comments, /verify-pr is CHEAP: its live-test is just `node dist/cli.js --help`
and the real-AWS core integration suite may be DEFERRED (offline/unit/corpus-
covered — state the deferral). The gate still applies because --help output is
user-visible; it is NOT asking for a real-AWS deploy here.

It is the ONLY legitimate setter of this marker. Do NOT call
`markgate set verify-pr` directly from a shell to bypass this hook —
the whole point of the gate is that an unverified PR cannot be opened
or merged. If a check legitimately cannot pass right now (e.g. no
AWS credentials for live-test), say so explicitly in the report; the
gate stays red so a human can decide whether to override.
EOF
exit 2

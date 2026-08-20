#!/usr/bin/env bash
# branch-gate.sh
#
# PreToolUse hook. Blocks `git commit` and `git push` when the working
# tree the command will actually act on is on `main` / `master`. All
# changes to cdk-real-drift must land via PR from a feature branch —
# direct commits/pushes to main are not allowed.
#
# WHY the cwd-aware resolution matters: this repo is regularly worked
# in via `git worktree`. The previous implementation derived the repo
# root from `BASH_SOURCE` (the hook script's location), which in a
# worktree-copy invocation pointed at the worktree itself — so the
# hook checked the worktree's branch (a feature branch) and allowed
# the commit, even when the user's actual command did
# `cd /path/to/parent && git commit` and the commit landed on the
# parent worktree's `main`. Real-world incident: 2026-05-04 lambda fix
# session, see memory feedback_git_use_C_in_worktree.md.
#
# Resolution order for "where will the git command actually run":
#   1. Explicit `git -C <path> commit/push` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field (the Bash tool's persisted cwd).
#   4. The hook process's own $PWD (fallback, almost never reached).

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit / git push — any other command passes through.
# The regex matches `git` + optional global flags (e.g. `-C <path>`,
# `-c <key>=<value>`, `--no-pager`, `--git-dir=<path>`) + the literal
# subcommand `commit` or `push`, anchored so that `commit` / `push`
# must appear in the GIT SUBCOMMAND POSITION — not as a substring of
# a refspec (`<sha>^{commit}`), a pathspec (`-- '*push*.md'`), or a
# `--grep=push` query.
#
# Anchors:
#   `^[[:space:]]*(cd[[:space:]]+...&&[[:space:]]*)?git`
#                             — line-start anchored (per memory rule
#                               feedback_hook_command_match_line_start.md)
#                               so `git commit` / `git push` substrings
#                               inside quoted argument bodies
#                               (`gh issue create --body "we should add
#                               git commit hook later"`) do NOT
#                               false-positive into a hard block. The
#                               optional leading `cd <path> &&` prefix
#                               preserves the worktree-aware
#                               `cd <side> && git commit` chain shape —
#                               `cd ... &&` at the literal line-start
#                               cannot match inside a JSON literal
#                               containing `&&` because the line-start
#                               anchor requires no leading characters
#                               except whitespace. Mirrors check-gate.sh
#                               (PR #562 fix pattern).
#   `([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*`
#                             — zero or more "flag tokens": each flag
#                               (`-X` or `--foo[=val]`) optionally
#                               followed by a separate non-flag value
#                               token (covers `-C <path>` /
#                               `-c <key>=<val>`).
#   `[[:space:]]+(commit|push)` — the subcommand position.
#   `([[:space:]]|$|[|;&`)])` — must end at a token boundary so
#                               `commit.gpgSign=false` (a `-c` value)
#                               is NOT counted as the subcommand;
#                               also recognizes pipeline / subshell
#                               separators so `git status; git commit`,
#                               `` `git push` `` all match.
#                               `$(git commit)` / backtick-wrapped
#                               forms are an accepted false-negative
#                               of the line-start tightening (per the
#                               memory rule's trade-off).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"

# Which commands this gate applies to. The segment matcher sees a gated verb in
# ANY position — `git add -A && git commit` used to run ungated
# (go-to-k/cdk-real-drift#1803).
GATE_RE_COMMIT_OR_PUSH='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+(commit|push)([[:space:]]|$)'
gate_matches "$cmd" "$GATE_RE_COMMIT_OR_PUSH" || exit 0

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_COMMIT_OR_PUSH")

# Repo opt-in scope (cdkd#1259): this gate protects repos that follow
# the feature-branch + PR + markgate convention. A session rooted in
# such a repo can still run git against OTHER repos (a personal blog, a
# scratch clone) where committing straight to main is the normal
# workflow; the gate must not fire there. Opt-in signal: a
# `.markgate.yml` at the resolved target repo's top level. Repos
# without it pass through untouched.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# Read the branch from the resolved target dir. `-C` lets git operate
# on a directory that isn't our cwd; if the dir doesn't exist or isn't
# inside a git repo, symbolic-ref returns empty and we fall through to
# the safe `exit 0` below (we can't gate what we can't see).
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

case "$branch" in
  main|master)
    echo "Blocked by branch-gate: target git working tree is on branch '$branch'." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  command: $cmd" >&2
    echo "Create a feature branch and open a PR instead (e.g. 'git -C \"$target_dir\" switch -c fix/xxx')." >&2
    echo "Direct commits/pushes to main are not allowed in this repo." >&2
    exit 2
    ;;
esac

exit 0

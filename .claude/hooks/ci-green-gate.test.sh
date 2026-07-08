#!/usr/bin/env bash
# Smoke test for ci-green-gate.sh.
#
# Stubs `gh` so `gh pr checks` returns a controlled exit code / output, and
# asserts the gate blocks a red or pending CI, passes a green one, honours the
# `--admin` human override, only fires on real `gh pr merge` invocations, and
# fails OPEN when the CI cannot be resolved.
#
# Run from the repo root: `bash .claude/hooks/ci-green-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-green-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

repo="$TMPDIR/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
# gh stub: `gh pr checks` echoes $GH_MOCK_OUT and exits $GH_MOCK_RC.
cat > "$SHIM_DIR/gh" <<'GH_EOF'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  [ -n "${GH_MOCK_OUT:-}" ] && printf '%s\n' "$GH_MOCK_OUT"
  exit "${GH_MOCK_RC:-0}"
fi
exit 0
GH_EOF
chmod +x "$SHIM_DIR/gh"
export PATH="$SHIM_DIR:$PATH"

fails=0
# run <expected_rc> <label> <command> [env assignments...]
run() {
  local want="$1" label="$2" cmd="$3"; shift 3
  local payload rc
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$repo")
  rc=$(env "$@" bash -c 'printf "%s" "$0" | '"$HOOK"' >/dev/null 2>&1; echo $?' "$payload")
  if [ "$rc" = "$want" ]; then
    printf 'ok   — %s (rc=%s)\n' "$label" "$rc"
  else
    printf 'FAIL — %s (want %s got %s)\n' "$label" "$want" "$rc"; fails=$((fails + 1))
  fi
}

run 0 "non-merge (gh pr create) passes"                 'gh pr create --title x'
run 0 "green CI (rc 0) merge passes"                    'gh pr merge 5 --squash'   GH_MOCK_RC=0
run 2 "red CI (rc 1) merge blocked"                     'gh pr merge 5 --squash'   GH_MOCK_RC=1 GH_MOCK_OUT="check fail"
run 2 "pending CI (rc 8) merge blocked"                 'gh pr merge 5 --squash'   GH_MOCK_RC=8 GH_MOCK_OUT="check pending"
run 0 "--admin override passes despite red"             'gh pr merge 5 --squash --admin' GH_MOCK_RC=1
run 0 "no-number merge (current branch) green passes"   'gh pr merge --squash'     GH_MOCK_RC=0
run 0 "quoted substring is not a real merge"            'echo "next: gh pr merge 5"'
run 0 "no-checks-reported fails open"                   'gh pr merge 5 --squash'   GH_MOCK_RC=1 GH_MOCK_OUT="no checks reported on the 'x' branch"

# not-a-git-repo fails open (cwd points outside any repo)
payload=$(printf '{"tool_input":{"command":"gh pr merge 5 --squash"},"cwd":"%s"}' "$TMPDIR/not-a-repo")
rc=$(env GH_MOCK_RC=1 bash -c 'printf "%s" "$0" | '"$HOOK"' >/dev/null 2>&1; echo $?' "$payload")
if [ "$rc" = 0 ]; then printf 'ok   — non-git cwd fails open (rc=0)\n'; else printf 'FAIL — non-git cwd (want 0 got %s)\n' "$rc"; fails=$((fails + 1)); fi

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi

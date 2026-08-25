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
# An origin, so a `-R go-to-k/x` in the cases below names THIS repo. Without it
# the gate's foreign-repo refusal fires first (a `-R` it cannot prove is local is
# treated as foreign) and `gh pr checks` is never reached — which is correct
# behaviour, but it would make the selector cases below measure nothing.
git -C "$repo" remote add origin https://github.com/go-to-k/x.git
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
# gh stub: `gh pr checks` echoes $GH_MOCK_OUT and exits $GH_MOCK_RC.
#
# IT ALSO RECORDS THE SELECTOR IT WAS GIVEN. Returning $GH_MOCK_RC regardless of
# the selector made this harness structurally unable to see WHICH PR the gate
# resolved -- so it stayed green while the gate read the literal string `gh` out
# of `gh -R o/r pr merge 1`, and again while a flag-first `gh pr merge --squash 1`
# lost the selector entirely. A stub that ignores an argument cannot fence a bug
# in how that argument is computed.
#
# With GH_MOCK_STRICT_SEL=1 it answers an EMPTY or non-numeric selector with the
# real binary's no-such-PR wording, which the gate's fail-open grep treats as
# "no CI to check". That turns a lost selector into an rc difference instead of a
# silent pass.
cat > "$SHIM_DIR/gh" <<'GH_EOF'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  sel="${3:-}"
  [ -n "${GH_SEL_FILE:-}" ] && printf '%s' "$sel" > "$GH_SEL_FILE"
  if [ "${GH_MOCK_STRICT_SEL:-0}" = "1" ]; then
    case "$sel" in
      ''|*[!0-9]*)
        printf 'no pull requests found for branch "%s"\n' "$sel"
        exit 1 ;;
    esac
  fi
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

# --- the SELECTOR the gate resolved --------------------------------------
# Blocker 1: `gh` does not require the number to sit immediately after the verb,
# and the sed+awk this replaced read it in either order. Blocker 2: the selector
# must come from the MATCHED SEGMENT, so a quoted mention cannot donate a number.
SELF="$TMPDIR/last-sel"
sel_check() {
  local want="$1" label="$2" cmd="$3" payload got
  : > "$SELF"
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$repo")
  env GH_MOCK_RC=0 GH_SEL_FILE="$SELF" bash -c 'printf "%s" "$0" | '"$HOOK"' >/dev/null 2>&1' "$payload"
  got=$(cat "$SELF" 2>/dev/null || printf '')
  if [ "$got" = "$want" ]; then
    printf 'ok   — selector: %s (%s)\n' "$label" "${got:-<empty>}"
  else
    printf 'FAIL — selector: %s (want %s got %s)\n' "$label" "${want:-<empty>}" "${got:-<empty>}"; fails=$((fails + 1))
  fi
}

sel_check 1    "number first"                  'gh pr merge 1 --squash'
sel_check 1    "FLAG FIRST, number after"      'gh pr merge --squash 1'
sel_check 1    "-R plus flag-first number"     'gh -R go-to-k/x pr merge --squash 1'
sel_check 2195 "two flags then the number"     'gh pr merge --delete-branch --squash 2195'
sel_check 2195 "-R glued, number first"        'gh -Rgo-to-k/x pr merge 2195 --squash'
sel_check ""   "no selector given"             'gh pr merge --squash'
# The quoted `gh pr merge 9` lives in ANOTHER segment; the bare merge that
# actually runs has no selector, and must not borrow it.
sel_check ""   "quoted mention cannot donate"  'gh pr create --body "then run gh pr merge 9 --squash" && gh pr merge'

# A lost selector must also change the VERDICT, not just the recorded value.
run 2 "flag-first selector still resolves the PR" 'gh pr merge --squash 5' \
  GH_MOCK_RC=1 GH_MOCK_OUT="check fail" GH_MOCK_STRICT_SEL=1
run 2 "-R flag-first selector still resolves"    'gh -R go-to-k/x pr merge --squash 5' \
  GH_MOCK_RC=1 GH_MOCK_OUT="check fail" GH_MOCK_STRICT_SEL=1

# A FOREIGN `-R` is refused before any probe runs: every check reads the resolved
# cwd, so auditing this repo and permitting a merge elsewhere is the wrong thing.
run 2 "foreign -R is refused"        'gh -R foreign/evil pr merge 5 --squash'  GH_MOCK_RC=0

# not-a-git-repo fails open (cwd points outside any repo)
payload=$(printf '{"tool_input":{"command":"gh pr merge 5 --squash"},"cwd":"%s"}' "$TMPDIR/not-a-repo")
rc=$(env GH_MOCK_RC=1 bash -c 'printf "%s" "$0" | '"$HOOK"' >/dev/null 2>&1; echo $?' "$payload")
if [ "$rc" = 0 ]; then printf 'ok   — non-git cwd fails open (rc=0)\n'; else printf 'FAIL — non-git cwd (want 0 got %s)\n' "$rc"; fails=$((fails + 1)); fi

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi

#!/usr/bin/env bash
# gh-repo-flag-parity.test.sh — cross-gate fence.
#
# THE PROPERTY: naming the repo on the command line must not change any gate's
# verdict. `-R <owner/repo>` says where the PR LIVES; it says nothing about what
# the command DOES, so a gate that refuses `gh pr merge` and permits
# `gh -R o/r pr merge` is simply wrong.
#
# This is the assertion that would have caught the 2026-08-25 bypass, and no
# per-gate harness could: each one drove its own hook with its own spelling and
# was green, because a bypassed gate returns the 0 that a PASS case expects.
# Measured against the shipped hooks, on the fixture below:
#
#   gate                    plain   -R form
#   verify-pr-gate            2        0     <- merges past /verify-pr
#   ci-green-gate             2        0     <- merges past red CI
#   bughunt-clean-gate        2        0     <- merges with live AWS resources
#
# THREE SPELLINGS, because `gh` accepts a flag value with a space, with `=`, or
# with NO SEPARATOR AT ALL. Verified against gh 2.89.0, all three returning the
# same PR number:
#
#   gh pr list --repo=go-to-k/cdkd   -> 2195
#   gh pr list -R=go-to-k/cdkd       -> 2195
#   gh pr list -Rgo-to-k/cdkd        -> 2195
#
# The glued form is the one a hand-written `(-C|-R|--repo)` alternation misses,
# which is why `GATE_GH_C` is `GATE_FLAGS`-style tokenisation instead.
#
# EVERY CASE ASSERTS NON-VACUITY TOO: the plain form must actually BLOCK. Parity
# alone is satisfied by a gate that is inert in both directions — which is
# exactly the state non-english-text-gate was in until `gh -C` was removed from
# its calls, and exactly how a suite can be green over a gate enforcing nothing.
#
# `gh` IS STUBBED, because that non-vacuity assertion is about the CODE and was
# accidentally about the ENVIRONMENT. On the GitHub runner `gh` exists but is
# unauthenticated, so non-english-text-gate took its LEGITIMATE fail-open arm,
# returned 0, and this harness reported "the gate is inert" about a gate that was
# fine (CI of go-to-k/cdk-real-drift#1815). A fence that cannot run where it
# matters most is the same category of fault as a stub more permissive than
# production: one certifies a defect as fixed, the other reports one that is not
# there, and both make the suite say something untrue.
#
# The stub is injected two ways because the gates reach `gh` two ways:
# `$GH_BIN` for the hook that honours that seam, and a PATH shim for the one that
# calls `gh` directly (and for its `command -v gh` probe).
#
# IT IS STRICT ABOUT `-C`, for the reason established one commit earlier: `gh`
# has no `-C` flag, and a stub that tolerates one certifies a broken call as
# working — which is exactly how non-english-text-gate stayed green at 15/15
# while enforcing nothing.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/gh-repo-flag-parity.test.sh"
HOOKS_DIR="$(dirname "$HOOK")"
REPO=go-to-k/cdk-real-drift
PASS=0
FAIL=0

# A fixture where EVERY gate has a reason to block: a `src/**` diff vs a base
# (defeats verify-pr-gate's docs-only exemption), no markgate markers, an armed
# bug-hunt sentinel, and a committed non-English line. Real git repos rather than
# mocks — each gate decides from what `git`/`markgate` actually report.
FIX=$(mktemp -d)
trap 'rm -rf "$FIX"' EXIT
git -C "$FIX" init -q -b main
# A real origin, so `-R go-to-k/cdk-real-drift` reads as THIS repo and the
# spellings below exercise each gate's actual logic rather than the
# foreign-repo refusal added alongside it.
git -C "$FIX" remote add origin https://github.com/go-to-k/cdk-real-drift.git
printf 'gates: {}\n' > "$FIX/.markgate.yml"
mkdir -p "$FIX/src"
printf 'export const a = 1;\n' > "$FIX/src/x.ts"
git -C "$FIX" add -A >/dev/null 2>&1
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1
git -C "$FIX" update-ref refs/remotes/origin/main "$(git -C "$FIX" rev-parse main)"
git -C "$FIX" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$FIX" checkout -q -b feat
printf 'export const a = 2;\n' > "$FIX/src/x.ts"
# A Japanese comment, so non-english-text-gate has something to refuse.
printf '// \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$FIX/src/jp.ts"
git -C "$FIX" add -A >/dev/null 2>&1
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm change >/dev/null 2>&1
printf 'stack-a\n' > "$FIX/.markgate-bughunt-pending"
printf 'stack-a\n' > "$FIX/.markgate-bughunt-pending-$(id -un)"

# A deterministic `gh`.
#
# `pr checks <sel>` is the load-bearing arm. A NUMERIC selector answers "red CI"
# so ci-green-gate blocks; anything else answers with the real binary's
# no-such-PR wording, which that gate's fail-open grep treats as "no CI to
# check" and PASSES. That asymmetry is deliberate: it is what makes this harness
# able to see a gate resolving the WRONG PR selector. It could not before —
# ci-green-gate extracted the literal string `gh` from `gh -R o/r pr merge 1`,
# and `gh pr checks gh` fails open in any repo with a remote, so the `-R` bypass
# survived the flag-absorber widening. The fixture had no remote, so `gh` failed
# with a different message and the case passed for the wrong reason.
GH_STUB="$FIX/bin/gh"
mkdir -p "$FIX/bin"

# The gates under test must be driven by the SAME interpreter the rest of the
# hook suites use, or this fence attests only to the developer machine's bash.
# `drive` and `foreign` below already prepend `$FIX/bin` to PATH for the `gh`
# stub, and a bare `bash` there resolves through that same PATH -- so a `bash`
# symlink in the stub directory redirects both call sites with no change to
# either function. (Verified: a command-prefix `PATH=` assignment IS used for
# the command's own lookup, so the symlink wins over /bin/bash.)
#
# Default /bin/bash; override with HOOK_BASH to take the other tally. An
# explicitly set HOOK_BASH that is not executable is FATAL rather than a silent
# fall back to PATH bash -- falling back hides a typo in the one setting this
# fence exists to pin. Only the built-in DEFAULT may fall back, since a machine
# without /bin/bash is a fact rather than a mistake. Same contract as
# issue-deferral-criteria-gate.test.sh, deliberately worded identically.
if [ -n "${HOOK_BASH:-}" ]; then
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 2
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook interpreter\n' >&2
    exit 2
  }
fi
ln -sf "$HOOK_BASH" "$FIX/bin/bash"
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

# ASSERTED, not merely printed. Deleting the `ln -sf` above left this suite
# fully green while the line just printed still named the interpreter -- a FALSE
# ATTESTATION, and the exact failure the shim exists to prevent (a fence that
# says which bash it measured while measuring another one). Drive one gate
# through the fixture PATH and make it report its own `$BASH_VERSION`.
gw_seen=$(PATH="$FIX/bin:$PATH" bash -c 'echo "$BASH_VERSION"')
gw_want=$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')
if [ "$gw_seen" = "$gw_want" ]; then
  echo "PASS: the fixture PATH resolves bash to HOOK_BASH ($gw_want)"
  PASS=$((PASS + 1))
else
  echo "FAIL: the fixture PATH resolves bash to $gw_seen, not HOOK_BASH ($gw_want)"
  FAIL=$((FAIL + 1))
fi
# And the FATAL arm: an explicitly set but non-executable HOOK_BASH must exit 2
# rather than fall back to PATH bash, because falling back hides a typo in the
# one setting this fence exists to pin.
gw_fatal=0
HOOK_BASH=/nonexistent/bash bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 || gw_fatal=$?
if [ "$gw_fatal" = "2" ] && [ -z "${GW_NO_RECURSE:-}" ]; then
  echo "PASS: a non-executable HOOK_BASH is FATAL (exit 2)"
  PASS=$((PASS + 1))
else
  echo "FAIL: a non-executable HOOK_BASH gave exit $gw_fatal, expected 2"
  FAIL=$((FAIL + 1))
fi
cat > "$GH_STUB" <<'STUB'
#!/usr/bin/env bash
# Mirror the real binary: an unknown shorthand is rejected before anything runs.
for a in "$@"; do
  case "$a" in
    -C) echo "unknown shorthand flag: 'C' in -C" >&2; exit 1 ;;
  esac
done
case "$1 ${2:-}" in
  "auth status") exit 0 ;;
  "pr view") printf '' ; exit 0 ;;
  "pr checks")
    sel="${3:-}"
    case "$sel" in
      ''|*[!0-9]*)
        # Not a PR number -> the wording gh really emits, which ci-green-gate
        # deliberately treats as fail-open.
        printf 'no pull requests found for branch "%s"\n' "$sel" >&2
        exit 1 ;;
      *)
        printf 'build\tfail\t1s\thttps://example.invalid/checks\n'
        exit 1 ;;
    esac ;;
  *) printf '' ; exit 0 ;;
esac
STUB
chmod +x "$GH_STUB"

drive() { # <hook.sh> <command> -> exit code
  local rc
  jq -n --arg c "$2" --arg d "$FIX" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
    | PATH="$FIX/bin:$PATH" GH_BIN="$GH_STUB" bash "$HOOKS_DIR/$1" >/dev/null 2>&1 && rc=0 || rc=$?
  printf '%s' "$rc"
}

# parity <hook.sh> <plain command>
# The repo flag is spliced in right after `gh`, in all three spellings.
parity() {
  local hook="$1" plain="$2" base rc_plain spelling rc
  base=$(drive "$hook" "$plain")

  # Non-vacuity: parity over two passes proves nothing.
  if [ "$base" = "2" ]; then
    echo "PASS: $hook blocks the plain form (exit 2, so parity is not vacuous)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $hook did NOT block the plain form (exit $base) — the gate is inert"
    echo "      command: $plain"
    FAIL=$((FAIL + 1))
    return
  fi

  for spelling in "-R $REPO" "--repo $REPO" "--repo=$REPO" "-R=$REPO" "-R$REPO"; do
    rc=$(drive "$hook" "${plain/gh /gh $spelling }")
    if [ "$rc" = "$base" ]; then
      echo "PASS: $hook — \`gh $spelling …\` matches the plain verdict (exit $rc)"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $hook — \`gh $spelling …\` returned $rc, plain returned $base (BYPASS)"
      FAIL=$((FAIL + 1))
    fi
  done
}

parity verify-pr-gate.sh        "gh pr merge 1 --squash"
parity ci-green-gate.sh         "gh pr merge 1 --squash"
parity bughunt-clean-gate.sh    "gh pr merge 1 --squash"
parity non-english-text-gate.sh "gh pr create --title t"
# The issue-mint gate is not a `pr` verb, but it reads the same flag absorber and
# `-R` is the cross-repo mirror flow's own spelling — its primary shape.
parity issue-dup-check-gate.sh  "gh issue create --title t --body 'no marker here'"
# The deferral gate is the other issue-mint gate, and it reads the SAME flag
# absorber. `-R` is the cross-repo mirror flow's own spelling here too, so a
# spelling that slips past the absorber is a live bypass of the criteria check.
parity issue-deferral-criteria-gate.sh \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- it needs its own PR'"

# --- a FOREIGN `-R` must be REFUSED, not audited -----------------------------
# The absorber matched `-R` and then discarded it: every probe runs against the
# resolved CWD, so `gh -R foreign/repo pr merge 5` had each gate inspect THIS
# repo and then permit a merge in a repo it never looked at. The parity cases
# above structurally cannot see this — they splice in this repo's own slug — so
# it needs its own assertion.
#
# issue-dup-check-gate is deliberately EXCLUDED: filing into a sibling repo with
# `-R` from this worktree is the cross-repo mirror flow, and that gate documents
# that the CWD decides the policy while `-R` only decides where the issue lands.
# It audits nothing repo-specific, so a foreign `-R` is correct there.
# The MESSAGE is asserted, not just the exit code. Every gate in this fixture
# already blocks for its own reasons, so `rc=2` alone is satisfied whether the
# foreign refusal fired or not — verified: deleting verify-pr-gate's refusal left
# an exit-code-only check green at 34/34. Naming the repo in the assertion is what
# makes it discriminate.
foreign() { # <hook.sh> <plain command>
  local hook="$1" out rc
  out=$(jq -n --arg c "${2/gh /gh -R foreign/evil }" --arg d "$FIX" \
        '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
        | PATH="$FIX/bin:$PATH" GH_BIN="$GH_STUB" bash "$HOOKS_DIR/$hook" 2>&1) && rc=0 || rc=$?
  if [ "$rc" = "2" ] && printf '%s' "$out" | grep -qF 'foreign/evil'; then
    echo "PASS: $hook refuses a foreign -R by name (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $hook did not refuse \`-R foreign/evil\` by name (exit $rc) — it audited THIS repo"
    FAIL=$((FAIL + 1))
  fi
}
foreign verify-pr-gate.sh        "gh pr merge 1 --squash"
foreign ci-green-gate.sh         "gh pr merge 1 --squash"
foreign non-english-text-gate.sh "gh pr create --title t"
# The control: the mirror flow's foreign `-R` must still reach the issue gate's
# own logic rather than being refused outright.
if [ "$(drive issue-dup-check-gate.sh "gh -R go-to-k/cdk-local issue create --body 'no marker'")" = "2" ] \
   && [ "$(drive issue-dup-check-gate.sh "gh -R go-to-k/cdk-local issue create --body 'x Dup-check: none'")" = "0" ]; then
  echo "PASS: issue-dup-check-gate still judges a foreign -R by its BODY (mirror flow)"
  PASS=$((PASS + 1))
else
  echo "FAIL: issue-dup-check-gate no longer judges a foreign -R by its body"
  FAIL=$((FAIL + 1))
fi
# Same control for the other issue-mint gate, and for the same reason: the cwd
# decides whose deferral policy applies, `-R` only decides where the issue lands.
if [ "$(drive issue-deferral-criteria-gate.sh "gh -R go-to-k/cdk-local issue create --body 'Session-fit: next (not this session) -- it needs its own PR'")" = "2" ] \
   && [ "$(drive issue-deferral-criteria-gate.sh "gh -R go-to-k/cdk-local issue create --body 'Session-fit: next (not this session) -- a new fixture must be written'")" = "0" ]; then
  echo "PASS: issue-deferral-criteria-gate still judges a foreign -R by its BODY (mirror flow)"
  PASS=$((PASS + 1))
else
  echo "FAIL: issue-deferral-criteria-gate no longer judges a foreign -R by its body"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]

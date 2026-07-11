#!/usr/bin/env bash
# Smoke tests for deploy-autoarm-gate.sh
#
# Feeds simulated tool input and asserts the hook (a) always exits 0 (never blocks a
# deploy) and (b) ARMS exactly on deploy-shaped commands. A stub bughunt-track (via
# CDKRD_AUTOARM_TRACK) records the arm to a temp file instead of touching the real
# sentinel. Run: bash .claude/hooks/deploy-autoarm-gate.test.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/deploy-autoarm-gate.sh"
PASS=0
FAIL=0

# run <name> <cmd> <expect_armed:0|1>
run() {
  local name="$1" cmd="$2" expect_armed="$3"

  local tmp stub armlog
  tmp=$(mktemp -d)
  armlog="$tmp/armed"
  stub="$tmp/track-stub.sh"
  cat > "$stub" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$armlog"
EOF
  chmod +x "$stub"

  local payload exit_code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  set +e
  printf '%s' "$payload" | CDKRD_AUTOARM_TRACK="$stub" bash "$HOOK" >/dev/null 2>&1
  exit_code=$?
  set -e

  local armed=0
  [ -s "$armlog" ] && armed=1

  local ok=1
  [ "$exit_code" -eq 0 ] || ok=0            # must NEVER block a deploy
  [ "$armed" -eq "$expect_armed" ] || ok=0

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "ok   - $name (exit=$exit_code armed=$armed)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name (exit=$exit_code armed=$armed, want armed=$expect_armed)"
  fi
  rm -rf "$tmp"
}

# deploy-shaped → ARM
run "aws cfn deploy"          "aws cloudformation deploy --template-file t.yaml --stack-name Foo" 1
run "aws create-stack"        "aws cloudformation create-stack --stack-name Foo --template-body file://t" 1
run "cd && npx cdk deploy"    "cd /tmp/x && npx cdk deploy Foo --require-approval never" 1
run "mise cdk deploy --all"   "mise exec -- cdk deploy --all" 1
run "sam deploy"              "sam deploy --guided" 1

# not a deploy → do NOT arm
run "cdk synth"               "cdk synth --app 'node app.cjs'" 0
run "cdk destroy"             "cdk destroy Foo" 0
run "delstack"               "delstack -s Foo -r us-east-1 -y -f" 0
run "cdkrd check"             "cdkrd check Foo --region us-east-1" 0
run "echo mentions deploy"    'echo "run aws cloudformation deploy later"' 0
run "git commit mentions"     "git commit -m 'add cloudformation deploy notes'" 0

# Per-session owner key: the arm goes to owner "autoarm-<sanitized session id>", from
# $CLAUDE_CODE_SESSION_ID (else the payload session_id, else "autoarm-shared").
# owner_check <name> <session-env> <payload-session> <expect-owner>
owner_check() {
  local name="$1" senv="$2" spayload="$3" expect="$4"
  local tmp stub armlog payload
  tmp=$(mktemp -d); armlog="$tmp/armed"; stub="$tmp/stub.sh"
  cat > "$stub" <<EOF
#!/usr/bin/env bash
echo "OWNER=\${CDKRD_BUGHUNT_OWNER}" >> "$armlog"
EOF
  chmod +x "$stub"
  payload="{\"tool_input\":{\"command\":$(printf '%s' "aws cloudformation deploy --stack-name Foo" | jq -Rs .)},\"cwd\":\"$tmp\",\"session_id\":\"$spayload\"}"
  set +e
  printf '%s' "$payload" | CLAUDE_CODE_SESSION_ID="$senv" CDKRD_AUTOARM_TRACK="$stub" bash "$HOOK" >/dev/null 2>&1
  set -e
  if grep -qx "OWNER=$expect" "$armlog" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "ok   - $name (owner=$expect)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name (got $(cat "$armlog" 2>/dev/null), want OWNER=$expect)"
  fi
  rm -rf "$tmp"
}

owner_check "session id from env sanitized"      "sess/ABC 123" ""         "autoarm-sess_ABC_123"
owner_check "session id from payload fallback"   ""             "pay-xyz"  "autoarm-pay-xyz"
owner_check "env wins over payload"              "envid"        "payid"    "autoarm-envid"
owner_check "no session id -> shared fallback"   ""             ""         "autoarm-shared"

# --- #1423: arming failures must be OBSERVABLE, never silent -----------------------
# A deploy-shaped command whose tracker cannot be armed used to no-op in total silence
# (deploy ran UNARMED, no token, no diagnostic). The hook must now (a) always exit 0
# (never block), (b) emit a WARNING to stderr, and (c) NOT falsely claim "ARMED".
#
# obs_check <name> <track-mode:missing|failing|ok> <expect_warn:0|1> <expect_armed_msg:0|1>
obs_check() {
  local name="$1" mode="$2" expect_warn="$3" expect_armed_msg="$4"
  local tmp track stderrf exit_code
  tmp=$(mktemp -d); stderrf="$tmp/stderr"

  case "$mode" in
    missing) track="$tmp/nope/bughunt-track.sh" ;;                # non-existent path
    failing) track="$tmp/track.sh"
             printf '#!/usr/bin/env bash\nexit 1\n' > "$track"; chmod +x "$track" ;;
    ok)      track="$tmp/track.sh"
             printf '#!/usr/bin/env bash\nexit 0\n' > "$track"; chmod +x "$track" ;;
  esac

  local payload
  payload="{\"tool_input\":{\"command\":$(printf '%s' "aws cloudformation deploy --stack-name Foo" | jq -Rs .)},\"session_id\":\"obs\"}"
  set +e
  printf '%s' "$payload" | CDKRD_AUTOARM_TRACK="$track" bash "$HOOK" >/dev/null 2>"$stderrf"
  exit_code=$?
  set -e

  local warned=0 armed_msg=0
  grep -qi "WARNING" "$stderrf" 2>/dev/null && warned=1
  grep -q "gate is now ARMED" "$stderrf" 2>/dev/null && armed_msg=1

  local ok=1
  [ "$exit_code" -eq 0 ] || ok=0                     # must NEVER block the deploy
  [ "$warned" -eq "$expect_warn" ] || ok=0
  [ "$armed_msg" -eq "$expect_armed_msg" ] || ok=0

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "ok   - $name (exit=$exit_code warn=$warned armed_msg=$armed_msg)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $name (exit=$exit_code warn=$warned armed_msg=$armed_msg, want warn=$expect_warn armed_msg=$expect_armed_msg)"
  fi
  rm -rf "$tmp"
}

obs_check "tracker missing -> warn, no false ARMED"   missing 1 0
obs_check "tracker add fails -> warn, no false ARMED"  failing 1 0
obs_check "tracker ok -> ARMED, no warning"            ok      0 1

# The default (no CDKRD_AUTOARM_TRACK) must resolve the REAL sibling tracker via the
# git-toplevel fallback and actually arm — proving the resolver hardening works even
# when BASH_SOURCE alone would not point at the checkout. Use a scratch owner so we
# do not pollute a real bughunt sentinel, and clean it up.
default_resolve_check() {
  local tmp stderrf exit_code
  tmp=$(mktemp -d); stderrf="$tmp/stderr"
  # A UNIQUE scratch SESSION id. The hook DERIVES its owner as `autoarm-<sid>` from the payload
  # session_id and IGNORES any inherited CDKRD_BUGHUNT_OWNER — so the cleanup below MUST target
  # `autoarm-<scratch_sid>`, the exact owner the hook writes. (An earlier version passed
  # session_id "deft" while cleaning a different owner string, so it cleared a non-existent owner
  # and leaked an `autoarm-deft` residue file into the shared pending dir.) $$ keeps it unique so
  # it can never collide with a real session's token.
  local scratch_sid="selftest-1423-$$"
  local payload
  payload="{\"tool_input\":{\"command\":$(printf '%s' "aws cloudformation deploy --stack-name Foo" | jq -Rs .)},\"session_id\":\"$scratch_sid\"}"
  set +e
  printf '%s' "$payload" | CLAUDE_CODE_SESSION_ID="" bash "$HOOK" >/dev/null 2>"$stderrf"
  exit_code=$?
  set -e
  # Resolve the sibling tracker AND the shared pending dir the hook armed the sentinel in, the
  # same way bughunt-track.sh does (dirname of the git common dir), so we can clean up AND assert
  # the cleanup actually worked.
  local root common_dir pending_dir owner_file
  root="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/skills/hunt-bugs/bughunt-track.sh"
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  pending_dir="$(dirname "$common_dir")/.markgate-bughunt-pending.d"
  owner_file="$pending_dir/autoarm-$scratch_sid"
  # Clean up the scratch sentinel the hook armed — owner is `autoarm-<scratch_sid>`.
  if [ -x "$root" ]; then
    CDKRD_BUGHUNT_OWNER="autoarm-$scratch_sid" CDKRD_BUGHUNT_FORCE_CLEAR=1 "$root" clear >/dev/null 2>&1 || true
  fi
  local ok=1
  [ "$exit_code" -eq 0 ] || ok=0
  # A successful default resolution prints the ARMED message (not the WARNING).
  grep -q "gate is now ARMED" "$stderrf" 2>/dev/null || ok=0
  grep -qi "WARNING" "$stderrf" 2>/dev/null && ok=0
  # Regression guard: cleanup must actually remove the scratch owner file — no leaked residue.
  [ ! -e "$owner_file" ] || ok=0
  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "ok   - default resolves real tracker via git-toplevel fallback (armed + cleaned up)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - default resolves real tracker via git-toplevel fallback (exit=$exit_code, residue=$([ -e "$owner_file" ] && echo yes || echo no)); stderr:"; cat "$stderrf"
    # Belt-and-suspenders: remove any leaked residue so even a FAILing run stays side-effect free.
    rm -f "$owner_file"
  fi
  rm -rf "$tmp"
}
default_resolve_check

echo "----"
echo "deploy-autoarm-gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

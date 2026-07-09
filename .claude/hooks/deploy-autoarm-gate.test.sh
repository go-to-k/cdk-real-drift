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

echo "----"
echo "deploy-autoarm-gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

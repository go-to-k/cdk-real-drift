#!/usr/bin/env bash
# Read-gap integration test (real AWS): deploy -> record -> check MUST be CLEAN
# AND the declared AWS::ECS::TaskSet must NOT be `skipped` (its 3-part composite
# CC identifier [Cluster, Service, Id] must be read). Without the dedicated 3-part
# adapter the TaskSet ValidationException-skips and its drift is invisible.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEcsTaskSetRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-ecs-taskset-rich" $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true

echo "=== [$STACK] assert TaskSet is READ, not skipped ==="
$CLI check "$STACK" --region "$REGION" --json > "/tmp/cdkrd-$STACK.json" 2>/dev/null || true
node -e '
  const fs=require("fs");
  const r=JSON.parse(fs.readFileSync("/tmp/cdkrd-'$STACK'.json","utf8"));
  const skipped=(r.findings||[]).filter(f=>f.tier==="skipped"&&f.resourceType==="AWS::ECS::TaskSet");
  if(skipped.length){console.error("READ-GAP: TaskSet skipped:",JSON.stringify(skipped));process.exit(1);}
  console.log("TaskSet read OK (not skipped)");
' || fail "TaskSet read-gap (skipped) — 3-part composite adapter missing"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

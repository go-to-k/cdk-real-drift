#!/usr/bin/env bash
# False-positive integration test (real AWS): barest SQS->Lambda EventSourceMapping
# + ApiGatewayV2 HTTP Api/Route. Every KNOWN_DEFAULTS-folded scalar must fold to
# atDefault. deploy -> check (pre-record) MUST be CLEAN -> record -> check CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevertNoop2x0714
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

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.pre.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FIRST-RUN FALSE POSITIVE ---"; fail "expected CLEAN pre-record (exit 0), got $rc"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

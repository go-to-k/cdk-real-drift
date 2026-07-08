#!/usr/bin/env bash
# Resource-level Condition integration test (real AWS): a resource guarded by a
# template Condition that evaluates FALSE is never created, so it must NOT surface
# as a permanent `skipped: no physical id` and must NOT keep `check --strict` red.
# The condition-TRUE resource and the Fn::If property selection must classify clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCfnConditions
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

echo "=== [$STACK] check MUST NOT list the condition-false ProdOnlyTopic as skipped ==="
$CLI check "$STACK" --region "$REGION" --verbose 2>&1 | tee "/tmp/cdkrd-$STACK.out"
grep -q "ProdOnlyTopic" "/tmp/cdkrd-$STACK.out" \
  && fail "condition-false ProdOnlyTopic still surfaced (skipped footer / drift)"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check --strict MUST pass (exit 0) on a clean recorded stack ==="
$CLI check "$STACK" --region "$REGION" --strict
rc=$?
[ "$rc" -eq 0 ] || fail "--strict expected exit 0 (coverage complete), got $rc"

echo "INTEG PASS ($STACK)"

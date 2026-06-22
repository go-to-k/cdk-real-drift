#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. An ALB ListenerRule declares each condition's Values set, and a
# weighted-forward action's target groups, in NON-sorted order. Any declared drift
# here is a nested-set reorder normalization FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegElbv2RuleValues
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

echo "=== [$STACK] harvest corpus + pre-record classification (no baseline) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-elbv2-rule-values" $CLI check "$STACK" --region "$REGION" --verbose 2>&1 | tee "/tmp/cdkrd-$STACK.pre.out" || true

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

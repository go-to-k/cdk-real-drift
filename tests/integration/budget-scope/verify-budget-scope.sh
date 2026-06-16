#!/usr/bin/env bash
# cdk-real-drift AWS::Budgets::Budget CostFilters (scope) FALSE-NEGATIVE integration test.
#
# The SDK-override reader for Budgets projected a THIN model without CostFilters — the
# budget's SCOPE (which services/accounts it watches). So an out-of-band change to the
# scope was undetectable: a declared CostFilters became a benign `readGap`, never drift.
# The fix adds CostFilters to the projection (FP-safe: an unfiltered budget returns `{}`,
# suppressed by isTrivialEmpty). This deploys a budget filtered to S3, flips the filter to
# EC2 out of band, and asserts `check` DETECTS it (before the fix: silent CLEAN/readGap).
#
# Budgets is a global service (us-east-1 endpoint). A cleanup trap destroys the stack.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegBudget
REGION=us-east-1
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out /tmp/cdkrd-budget*.json
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy budget (CostFilters = S3) ==="
AWS_REGION="$REGION" npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ACCT="$(aws sts get-caller-identity --query Account --output text)"
NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Budgets::Budget'].PhysicalResourceId" --output text)"
[ -n "$NAME" ] || fail "could not resolve budget name"
echo "budget=$NAME account=$ACCT"

echo "=== record + check should be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after record"

echo "=== flip CostFilters to EC2 out of band ==="
aws budgets describe-budget --account-id "$ACCT" --budget-name "$NAME" --query Budget > /tmp/cdkrd-budget.json
jq '.CostFilters = {"Service":["Amazon Elastic Compute Cloud - Compute"]} | del(.CalculatedSpend)' \
  /tmp/cdkrd-budget.json > /tmp/cdkrd-budget2.json
aws budgets update-budget --account-id "$ACCT" --new-budget file:///tmp/cdkrd-budget2.json \
  || fail "update-budget"

echo "=== check MUST now DETECT the scope change (was a silent readGap) ==="
OUT=/tmp/cdkrd-budget-check.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 (the CostFilters scope change must be detected), got $rc"
grep -qi "CostFilters" "$OUT" || fail "CostFilters change not reported — still projected away?"

echo "INTEG PASS"

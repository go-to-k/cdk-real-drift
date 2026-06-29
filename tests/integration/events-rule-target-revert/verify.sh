#!/usr/bin/env bash
# Regression integration test (real AWS) for issue #421 TASK 2 — removed-collection
# REVERT on an EventBridge Rule's `Targets`. Targets are managed by a separate API
# (PutTargets/RemoveTargets), so this exercises whether a whole-property re-add via
# Cloud Control UpdateResource works for a removed collection.
# deploy -> record -> remove all targets out of band -> check MUST detect (Targets
# whole-property drift) -> revert MUST re-apply Targets -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEventsRuleTargetRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

RULE=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Events::Rule'].PhysicalResourceId" --output text)
[ -n "$RULE" ] || fail "no rule"
echo "rule=$RULE"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] targets BEFORE removal ==="
IDS=$(aws events list-targets-by-rule --rule "$RULE" --region "$REGION" --query 'Targets[].Id' --output text)
echo "target ids=$IDS"
[ -n "$IDS" ] || fail "no targets to remove"

echo "=== [$STACK] remove all targets out of band (CC will omit Targets) ==="
aws events remove-targets --rule "$RULE" --ids $IDS --region "$REGION" || fail "remove-targets"

echo "=== [$STACK] check MUST detect the removed Targets collection ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed Targets not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-apply Targets) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] targets AFTER revert ==="
AFTER=$(aws events list-targets-by-rule --rule "$RULE" --region "$REGION" --query 'length(Targets)' --output text)
echo "target count after revert=$AFTER"
[ "$AFTER" = "2" ] || fail "expected 2 targets restored, got $AFTER"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"

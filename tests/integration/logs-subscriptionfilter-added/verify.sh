#!/usr/bin/env bash
# cdk-real-drift `added` integ for CloudWatch Logs SUBSCRIPTION filters (a 2nd child type of
# the AWS::Logs::LogGroup parent).
#   deploy fixture (LogGroup + Lambda dest + one declared SubscriptionFilter) -> record -> CLEAN
#     (the declared subscription filter must NOT flag)
#   -> put-subscription-filter an UNDECLARED filter on the SAME log group out of band -> check
#      reports it under [Potential Drift] as AWS::Logs::SubscriptionFilter, NOT drift (exit 0)
#   -> `revert --remove-unrecorded` DELETES it via Cloud Control DeleteResource (proves the
#      composite LogGroupName|FilterName identifier) -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). CloudWatch Logs limits a log
# group to 2 subscription filters, so the test uses 1 declared + 1 out-of-band.
# A cleanup trap destroys the stack even on failure; deleting the LogGroup CASCADES its
# subscription filters (RemovalPolicy DESTROY in app.ts), and the Lambda's auto log group is
# swept, so there are no stack-external orphans.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLogsSubscriptionFilterAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  # belt-and-suspenders: the Lambda destination has an auto-created /aws/lambda/* log group
  # that is stack-external (delstack can't see it) — sweep it so nothing is left behind.
  if [ -n "${FN:-}" ]; then
    aws logs delete-log-group --log-group-name "/aws/lambda/$FN" --region "$REGION" >/dev/null 2>&1 || true
  fi
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (LogGroup + Lambda + declared SubscriptionFilter) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

LG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)"
FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$LG" ] && [ -n "$FN" ] || fail "could not resolve LogGroup / Lambda name"
FN_ARN="$(aws lambda get-function --function-name "$FN" --region "$REGION" --query 'Configuration.FunctionArn' --output text)"
echo "log-group=$LG lambda=$FN"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (the declared subscription filter must NOT flag) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record — declared subscription filter leaked?"

echo "=== put an UNDECLARED subscription filter on the log group out of band ==="
aws logs put-subscription-filter --log-group-name "$LG" --filter-name cdkrd-oob-sub \
  --filter-pattern "" --destination-arn "$FN_ARN" --region "$REGION" >/dev/null \
  || fail "put-subscription-filter"

echo "=== check reports it as Not-Recorded inventory (AWS::Logs::SubscriptionFilter), NOT drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-lsf.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-lsf.out || fail "added subscription filter not under [Potential Drift]"
grep -q "AWS::Logs::SubscriptionFilter" /tmp/cdkrd-integ-lsf.out || fail "the out-of-band subscription filter not reported"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource on LogGroupName|FilterName) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-lsf-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-lsf-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-lsf-revert.out || fail "revert did not converge to CLEAN"

echo "=== the out-of-band subscription filter must be gone from AWS ==="
remaining="$(aws logs describe-subscription-filters --log-group-name "$LG" \
  --filter-name-prefix cdkrd-oob-sub --region "$REGION" --query "subscriptionFilters" --output text 2>/dev/null)"
[ -z "$remaining" ] || fail "the reverted subscription filter still exists (delete did not take effect)"

echo "INTEG PASS"

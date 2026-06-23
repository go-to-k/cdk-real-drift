#!/usr/bin/env bash
# SubscriptionFilter detect + revert integration test (real AWS): the false-NEGATIVE
# half. Deploy -> record -> change the DECLARED MUTABLE FilterPattern out of band
# (console-edit scenario via put-subscription-filter) -> check MUST DETECT the
# declared drift (exit 1) -> revert -> check MUST be CLEAN and the live FilterPattern
# MUST be restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLogsSubscriptionfilterRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

LG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)"
[ -n "$LG" ] || fail "could not resolve log group name"

# resolve the live subscription filter (name, destination arn, role arn, pattern)
read -r FNAME DARN RARN ORIG < <(aws logs describe-subscription-filters \
  --log-group-name "$LG" --region "$REGION" \
  --query "subscriptionFilters[0].[filterName,destinationArn,roleArn,filterPattern]" --output text)
[ -n "$FNAME" ] && [ -n "$DARN" ] || fail "could not resolve subscription filter"
echo "filter=$FNAME dest=$DARN role=$RARN origPattern=[$ORIG]"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change FilterPattern (console-edit) ==="
ROLE_ARG=()
[ -n "$RARN" ] && [ "$RARN" != "None" ] && ROLE_ARG=(--role-arn "$RARN")
aws logs put-subscription-filter --log-group-name "$LG" --filter-name "$FNAME" \
  --filter-pattern '{ $.level = "FATAL" }' --destination-arn "$DARN" "${ROLE_ARG[@]}" \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-subfilter-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "FilterPattern" /tmp/cdkrd-subfilter-detect.out || fail "FilterPattern not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live FilterPattern MUST be restored ==="
GOT="$(aws logs describe-subscription-filters --log-group-name "$LG" --region "$REGION" \
  --query "subscriptionFilters[0].filterPattern" --output text)"
[ "$GOT" = "$ORIG" ] || fail "live FilterPattern not restored (got: [$GOT], want: [$ORIG])"

echo "INTEG PASS ($STACK detect+revert)"

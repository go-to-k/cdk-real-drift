#!/usr/bin/env bash
# revconv5 hunt regression (real AWS): barest first-run FP probe + post-update echo probe
# + the batch-7 revert-convergence / off-flip detection cycle over KNOWN_DEFAULTS-folded
# mutable props (Lambda RecursiveLoop + RuntimeManagementConfig, HTTP API
# DisableExecuteApiEndpoint, SES ConfigurationSet sending/reputation toggles, KinesisVideo
# DataRetentionInHours, CloudTrail EventSelectors, S3 PublicAccessBlockConfiguration).
# Hunt 2026-07-14 findings this pins live:
#   - the SES ConfigurationSet + S3 Bucket PAB off-flips were INVISIBLE (all-boolean-object
#     pins swallowed by isTrivialEmpty) — fixed via MEANINGFUL_WHEN_OFF entries
#   - every probed prop converges via the bare `remove` revert (no RSDP entry needed)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevconv5
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

echo "=== [$STACK] FIRST check (pre-record) MUST show zero Potential Drift ==="
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-revconv5-first.out
grep -q "Potential Drift" /tmp/cdkrd-revconv5-first.out && fail "first-run FP on a fresh barest deploy"

echo "=== [$STACK] record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] neutral rev=2 redeploy (post-update echo probe) ==="
npx cdk deploy -f "$STACK" --require-approval never -c rev=2 || fail "rev=2 redeploy"
$CLI check "$STACK" --region "$REGION" --fail
[ "${PIPESTATUS[0]:-$?}" -eq 0 ] || fail "post-update echo materialized undeclared drift"

echo "=== [$STACK] out-of-band mutations (all probes) ==="
FN_NAME=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='Fn9270CBC0'].PhysicalResourceId" --output text)
BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='TrailBucketA831CE63'].PhysicalResourceId" --output text)
API_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='HttpApi'].PhysicalResourceId" --output text)
aws lambda put-function-recursion-config --function-name "$FN_NAME" --recursive-loop Allow --region "$REGION" >/dev/null || fail "mutate recursion"
aws lambda put-runtime-management-config --function-name "$FN_NAME" --update-runtime-on FunctionUpdate --region "$REGION" >/dev/null || fail "mutate rmc"
aws apigatewayv2 update-api --api-id "$API_ID" --disable-execute-api-endpoint --region "$REGION" >/dev/null || fail "mutate api"
aws sesv2 put-configuration-set-sending-options --configuration-set-name cdkrd-hunt-revconv5-cs --no-sending-enabled --region "$REGION" || fail "mutate ses send"
aws sesv2 put-configuration-set-reputation-options --configuration-set-name cdkrd-hunt-revconv5-cs --no-reputation-metrics-enabled --region "$REGION" || fail "mutate ses rep"
KVS_V=$(aws kinesisvideo describe-stream --stream-name cdkrd-hunt-revconv5-kvs --region "$REGION" --query StreamInfo.Version --output text)
aws kinesisvideo update-data-retention --stream-name cdkrd-hunt-revconv5-kvs --current-version "$KVS_V" \
  --operation INCREASE_DATA_RETENTION --data-retention-change-in-hours 24 --region "$REGION" || fail "mutate kvs"
aws cloudtrail put-event-selectors --trail-name cdkrd-hunt-revconv5-trail \
  --event-selectors '[{"ReadWriteType":"WriteOnly","IncludeManagementEvents":true}]' --region "$REGION" >/dev/null || fail "mutate trail"
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false || fail "mutate pab"

echo "=== [$STACK] check MUST detect all 8 mutations (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-revconv5-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for p in RecursiveLoop RuntimeManagementConfig DisableExecuteApiEndpoint SendingOptions ReputationOptions DataRetentionInHours EventSelectors PublicAccessBlockConfiguration; do
  grep -q "$p" /tmp/cdkrd-revconv5-detect.out || fail "mutation NOT detected: $p"
done

echo "=== [$STACK] revert MUST converge every probe (batch-7 result: all via bare remove) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
[ "$(aws lambda get-function-recursion-config --function-name "$FN_NAME" --region "$REGION" --query RecursiveLoop --output text)" = "Terminate" ] || fail "RecursiveLoop did not converge"
[ "$(aws lambda get-runtime-management-config --function-name "$FN_NAME" --region "$REGION" --query UpdateRuntimeOn --output text)" = "Auto" ] || fail "RuntimeManagementConfig did not converge"
[ "$(aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" --query DisableExecuteApiEndpoint --output text)" = "False" ] || fail "DisableExecuteApiEndpoint did not converge"
[ "$(aws sesv2 get-configuration-set --configuration-set-name cdkrd-hunt-revconv5-cs --region "$REGION" --query SendingOptions.SendingEnabled --output text)" = "True" ] || fail "SendingEnabled did not converge"
[ "$(aws sesv2 get-configuration-set --configuration-set-name cdkrd-hunt-revconv5-cs --region "$REGION" --query ReputationOptions.ReputationMetricsEnabled --output text)" = "True" ] || fail "ReputationMetricsEnabled did not converge"
[ "$(aws kinesisvideo describe-stream --stream-name cdkrd-hunt-revconv5-kvs --region "$REGION" --query StreamInfo.DataRetentionInHours --output text)" = "0" ] || fail "DataRetentionInHours did not converge"
[ "$(aws cloudtrail get-event-selectors --trail-name cdkrd-hunt-revconv5-trail --region "$REGION" --query 'EventSelectors[0].ReadWriteType' --output text)" = "All" ] || fail "EventSelectors did not converge"
[ "$(aws s3api get-public-access-block --bucket "$BUCKET" --region "$REGION" --query PublicAccessBlockConfiguration.BlockPublicAcls --output text)" = "True" ] || fail "PublicAccessBlockConfiguration did not converge"

echo "=== [$STACK] final check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

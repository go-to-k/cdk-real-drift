#!/usr/bin/env bash
# Revert-convergence probe batch 4 (real AWS): mutate seven folded MUTABLE
# surfaces out of band -> check MUST DETECT -> revert -> check MUST be CLEAN ->
# the LIVE values MUST be back at their defaults (a silent no-op revert is the
# #1571 class; the API shape is not a predictor, only this live test answers).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714RevConv3
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
WG=cdkrd-hunt0714-wg

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?LogicalResourceId=='$1'].PhysicalResourceId" --output text
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN (barest Athena WG + UserPoolClient FP probe), then record ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see pre.out)"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

QURL="$(aws sqs get-queue-url --queue-name "$(phys Conv3Queue | awk -F/ '{print $NF}')" --region "$REGION" --query QueueUrl --output text)"
TBL="$(phys Conv3Table)"
SM_ARN="$(phys Conv3Sfn)"
SFN_LG="$(phys Conv3SfnLogs)"
API="$(phys Conv3RestApi)"
POOL="$(phys Conv3Pool)"
CLIENT="$(phys Conv3PoolClient)"
SCHED="$(phys Conv3Schedule | awk -F/ '{print $NF}')"

echo "=== [$STACK] mutate out of band (7 surfaces) ==="
aws sqs set-queue-attributes --queue-url "$QURL" --region "$REGION" \
  --attributes SqsManagedSseEnabled=false || fail "mutate sqs sse"
aws athena update-work-group --work-group "$WG" --region "$REGION" --state DISABLED || fail "mutate athena state"
aws dynamodb update-table --table-name "$TBL" --region "$REGION" \
  --deletion-protection-enabled >/dev/null || fail "mutate ddb delprot"
LG_ARN="$(aws logs describe-log-groups --log-group-name-prefix "$SFN_LG" --region "$REGION" \
  --query 'logGroups[0].arn' --output text)"
aws stepfunctions update-state-machine --state-machine-arn "$SM_ARN" --region "$REGION" \
  --logging-configuration "level=ALL,includeExecutionData=true,destinations=[{cloudWatchLogsLogGroup={logGroupArn=$LG_ARN}}]" \
  >/dev/null || fail "mutate sfn logging"
aws apigateway update-rest-api --rest-api-id "$API" --region "$REGION" \
  --patch-operations op=replace,path=/disableExecuteApiEndpoint,value=true >/dev/null || fail "mutate apigw"
aws cognito-idp update-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" --region "$REGION" \
  --refresh-token-validity 60 >/dev/null || fail "mutate cognito client"
TGT="$(aws scheduler get-schedule --name "$SCHED" --region "$REGION" --query 'Target' --output json)"
aws scheduler update-schedule --name "$SCHED" --region "$REGION" --state DISABLED \
  --schedule-expression 'rate(12 hours)' --flexible-time-window Mode=OFF \
  --target "$TGT" >/dev/null || fail "mutate scheduler state"
sleep 20

echo "=== [$STACK] check MUST DETECT all 7 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for needle in SqsManagedSseEnabled State DeletionProtectionEnabled LoggingConfiguration DisableExecuteApiEndpoint RefreshTokenValidity; do
  grep -q "$needle" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: $needle"
done

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged path (see output)"
sleep 20

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert — a revert did not converge"

echo "=== [$STACK] live values MUST be back at their defaults ==="
SSE="$(aws sqs get-queue-attributes --queue-url "$QURL" --region "$REGION" \
  --attribute-names SqsManagedSseEnabled --query 'Attributes.SqsManagedSseEnabled' --output text)"
[ "$SSE" = "true" ] || fail "SqsManagedSseEnabled still $SSE (revert no-op)"
WGS="$(aws athena get-work-group --work-group "$WG" --region "$REGION" \
  --query 'WorkGroup.State' --output text)"
[ "$WGS" = "ENABLED" ] || fail "Athena WorkGroup State still $WGS (revert no-op)"
DP="$(aws dynamodb describe-table --table-name "$TBL" --region "$REGION" \
  --query 'Table.DeletionProtectionEnabled' --output text)"
[ "$DP" = "False" ] || fail "DDB DeletionProtectionEnabled still $DP (revert no-op)"
LVL="$(aws stepfunctions describe-state-machine --state-machine-arn "$SM_ARN" --region "$REGION" \
  --query 'loggingConfiguration.level' --output text)"
[ "$LVL" = "OFF" ] || fail "SFN logging level still $LVL (revert no-op)"
DEE="$(aws apigateway get-rest-api --rest-api-id "$API" --region "$REGION" \
  --query 'disableExecuteApiEndpoint' --output text)"
{ [ "$DEE" = "False" ] || [ "$DEE" = "None" ]; } || fail "DisableExecuteApiEndpoint still $DEE (revert no-op)"
RTV="$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" --region "$REGION" \
  --query 'UserPoolClient.RefreshTokenValidity' --output text)"
[ "$RTV" = "30" ] || fail "RefreshTokenValidity still $RTV (revert no-op)"
SST="$(aws scheduler get-schedule --name "$SCHED" --region "$REGION" --query 'State' --output text)"
[ "$SST" = "ENABLED" ] || fail "Schedule State still $SST (revert no-op)"

echo "INTEG PASS ($STACK detect+revert batch 4)"

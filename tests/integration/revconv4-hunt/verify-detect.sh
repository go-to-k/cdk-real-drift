#!/usr/bin/env bash
# Revert-convergence probe batch 5 (real AWS): mutate ten folded MUTABLE
# surfaces out of band -> check MUST DETECT -> revert -> check MUST be CLEAN ->
# the LIVE values MUST be back at their defaults (a silent no-op revert is the
# #1571 class; the API shape is not a predictor, only this live test answers).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714RevConv4
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ALARM=cdkrd-hunt0714-conv4-alarm
COMPOSITE=cdkrd-hunt0714-conv4-composite
CB=cdkrd-hunt0714-conv4-cb
APPSYNC_NAME=cdkrd-hunt0714-conv4-appsync
MCQ=cdkrd-hunt0714-conv4-mcq
SCHED=cdkrd-hunt0714-conv4-sched
CRAWLER=cdkrd-hunt0714-conv4-crawler
PIPE=cdkrd-hunt0714-conv4-pipe

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

echo "=== [$STACK] first check MUST be CLEAN (barest ECS cluster / AppSync / crawler / pipe FP probe), then record ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see pre.out)"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

ECS="$(phys Conv4EcsCluster)"
API="$(phys Conv4RestApi)"
APPSYNC_ID="$(phys Conv4AppSync | awk -F/ '{print $NF}')"

echo "=== [$STACK] mutate out of band (10 surfaces) ==="
aws ecs update-cluster-settings --cluster "$ECS" --region "$REGION" \
  --settings name=containerInsights,value=enabled >/dev/null || fail "mutate ecs insights"
aws cloudwatch put-metric-alarm --alarm-name "$ALARM" --region "$REGION" \
  --namespace cdkrd/hunt --metric-name Conv4Metric --statistic Sum --period 300 \
  --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching || fail "mutate alarm treatmissing"
aws cloudwatch disable-alarm-actions --alarm-names "$COMPOSITE" --region "$REGION" \
  || fail "mutate composite actions"
aws codebuild update-project --name "$CB" --region "$REGION" \
  --timeout-in-minutes 30 --queued-timeout-in-minutes 240 >/dev/null || fail "mutate codebuild timeouts"
aws appsync update-graphql-api --api-id "$APPSYNC_ID" --region "$REGION" \
  --name "$APPSYNC_NAME" --authentication-type API_KEY \
  --introspection-config DISABLED >/dev/null || fail "mutate appsync introspection"
aws apigateway update-rest-api --rest-api-id "$API" --region "$REGION" \
  --patch-operations op=replace,path=/apiKeySource,value=AUTHORIZER >/dev/null || fail "mutate apigw keysource"
aws mediaconvert update-queue --name "$MCQ" --region "$REGION" --status PAUSED >/dev/null \
  || fail "mutate mediaconvert status"
TGT="$(aws scheduler get-schedule --name "$SCHED" --region "$REGION" --query 'Target' --output json)"
aws scheduler update-schedule --name "$SCHED" --region "$REGION" \
  --schedule-expression 'rate(12 hours)' --flexible-time-window Mode=OFF \
  --schedule-expression-timezone 'Asia/Tokyo' --target "$TGT" >/dev/null || fail "mutate scheduler tz"
aws glue update-crawler --name "$CRAWLER" --region "$REGION" \
  --schema-change-policy UpdateBehavior=LOG,DeleteBehavior=LOG || fail "mutate crawler policy"
aws pipes stop-pipe --name "$PIPE" --region "$REGION" >/dev/null || fail "mutate pipe state"
sleep 25

echo "=== [$STACK] check MUST DETECT all 10 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for needle in ClusterSettings TreatMissingData ActionsEnabled TimeoutInMinutes QueuedTimeoutInMinutes \
  IntrospectionConfig ApiKeySourceType Status ScheduleExpressionTimezone SchemaChangePolicy DesiredState; do
  grep -q "$needle" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: $needle"
done

echo "=== [$STACK] restore the not-yet-revertable surfaces out of band ==="
# CodeBuild::Project and MediaConvert::Queue are SDK_OVERRIDES read-only types
# ("type not revertable yet", #1623) — their mutations are detect-only in this
# fixture, so restore them manually before revert to let it converge to zero.
aws codebuild update-project --name "$CB" --region "$REGION" \
  --timeout-in-minutes 60 --queued-timeout-in-minutes 480 >/dev/null || fail "restore codebuild timeouts"
aws mediaconvert update-queue --name "$MCQ" --region "$REGION" --status ACTIVE >/dev/null \
  || fail "restore mediaconvert status"

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged path (see output)"
sleep 25

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert — a revert did not converge"

echo "=== [$STACK] live values MUST be back at their defaults ==="
CI="$(aws ecs describe-clusters --clusters "$ECS" --region "$REGION" --include SETTINGS \
  --query "clusters[0].settings[?name=='containerInsights'].value | [0]" --output text)"
{ [ "$CI" = "disabled" ] || [ "$CI" = "None" ]; } || fail "containerInsights still $CI (revert no-op)"
TMD="$(aws cloudwatch describe-alarms --alarm-names "$ALARM" --region "$REGION" \
  --query 'MetricAlarms[0].TreatMissingData' --output text)"
{ [ "$TMD" = "missing" ] || [ "$TMD" = "None" ]; } || fail "TreatMissingData still $TMD (revert no-op)"
AE="$(aws cloudwatch describe-alarms --alarm-names "$COMPOSITE" --alarm-types CompositeAlarm --region "$REGION" \
  --query 'CompositeAlarms[0].ActionsEnabled' --output text)"
[ "$AE" = "True" ] || fail "composite ActionsEnabled still $AE (revert no-op)"
CBT="$(aws codebuild batch-get-projects --names "$CB" --region "$REGION" \
  --query 'projects[0].timeoutInMinutes' --output text)"
[ "$CBT" = "60" ] || fail "CodeBuild timeoutInMinutes still $CBT (revert no-op)"
CBQ="$(aws codebuild batch-get-projects --names "$CB" --region "$REGION" \
  --query 'projects[0].queuedTimeoutInMinutes' --output text)"
[ "$CBQ" = "480" ] || fail "CodeBuild queuedTimeoutInMinutes still $CBQ (revert no-op)"
INTRO="$(aws appsync get-graphql-api --api-id "$APPSYNC_ID" --region "$REGION" \
  --query 'graphqlApi.introspectionConfig' --output text)"
{ [ "$INTRO" = "ENABLED" ] || [ "$INTRO" = "None" ]; } || fail "IntrospectionConfig still $INTRO (revert no-op)"
AKS="$(aws apigateway get-rest-api --rest-api-id "$API" --region "$REGION" \
  --query 'apiKeySource' --output text)"
[ "$AKS" = "HEADER" ] || fail "ApiKeySourceType still $AKS (revert no-op)"
MCS="$(aws mediaconvert get-queue --name "$MCQ" --region "$REGION" --query 'Queue.Status' --output text)"
[ "$MCS" = "ACTIVE" ] || fail "MediaConvert Queue Status still $MCS (revert no-op)"
STZ="$(aws scheduler get-schedule --name "$SCHED" --region "$REGION" \
  --query 'ScheduleExpressionTimezone' --output text)"
{ [ "$STZ" = "UTC" ] || [ "$STZ" = "None" ]; } || fail "ScheduleExpressionTimezone still $STZ (revert no-op)"
SCP="$(aws glue get-crawler --name "$CRAWLER" --region "$REGION" \
  --query '[Crawler.SchemaChangePolicy.UpdateBehavior,Crawler.SchemaChangePolicy.DeleteBehavior]' --output text)"
[ "$SCP" = "UPDATE_IN_DATABASE	DEPRECATE_IN_DATABASE" ] || fail "Crawler SchemaChangePolicy still $SCP (revert no-op)"
PDS="$(aws pipes describe-pipe --name "$PIPE" --region "$REGION" --query 'DesiredState' --output text)"
[ "$PDS" = "RUNNING" ] || fail "Pipe DesiredState still $PDS (revert no-op)"

echo "INTEG PASS ($STACK detect+revert batch 5)"

#!/usr/bin/env bash
# enum-added2-hunt (2026-08-03): live end-to-end proof of the four cheap new child
# enumerators (#1720/#1721 — SSM MaintenanceWindow, CodeDeploy Application,
# Elastic Beanstalk Application, Application Auto Scaling ScalableTarget; the
# GuardDuty half lives in verify-gd.sh).
#   1. deploy (declared child per parent) -> FIRST check (pre-record) must be CLEAN
#      (declared children NOT flagged; #1723 CodeDeploy DG folds hold live)
#   2. record -> check --fail CLEAN
#   3. OOB-add one child per parent -> ALL four must surface as `added`
#   4. cdkrd revert --yes deletes the OOB children (the delete-kind plan path over
#      the enumerators' composite identifiers) -> check --fail CLEAN
#   5. FN probe: OOB update-maintenance-window schedule -> detect -> revert -> live
#      value restored -> CLEAN
#   6. #1723 fold probe: OOB update-deployment-group DeploymentConfigName ->
#      detect -> revert -> live value must be back at CodeDeployDefault.OneAtATime
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0803EnumAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
BUNDLE_BUCKET=cdkrd-hunt-ebbundle-0803-x9z7q

cleanup() {
  echo "--- cleanup ($STACK) ---"
  # OOB children first (idempotent) so teardown never trips on them
  aws deploy delete-deployment-group --application-name cdkrd-hunt-cd-0803 --deployment-group-name cdkrd-oob-dg --region "$REGION" >/dev/null 2>&1 || true
  aws elasticbeanstalk delete-application-version --application-name cdkrd-hunt-eb-0803 --version-label cdkrd-oob-ver --region "$REGION" >/dev/null 2>&1 || true
  if [ -n "${OOB_TARGET_ID:-}" ] && [ -n "${WINDOW_ID:-}" ]; then
    aws ssm deregister-target-from-maintenance-window --window-id "$WINDOW_ID" --window-target-id "$OOB_TARGET_ID" --region "$REGION" >/dev/null 2>&1 || true
  fi
  aws application-autoscaling delete-scaling-policy --policy-name cdkrd-oob-pol --service-namespace dynamodb --resource-id "table/${TABLE_NAME:-none}" --scalable-dimension dynamodb:table:ReadCapacityUnits --region "$REGION" >/dev/null 2>&1 || true
  aws s3 rm "s3://$BUNDLE_BUCKET/bundle.zip" --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

# entry lines inside the [Potential Drift] block (NOT the summary header — see the
# grep -c gotcha in the hunt skill)
drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+ \(AWS::' || true
}

SS="$(aws elasticbeanstalk list-available-solution-stacks --region "$REGION" \
  --query "SolutionStacks[?contains(@,'Amazon Linux 2023') && contains(@,'running Docker')]|[0]" --output text)"
[ -n "$SS" ] && [ "$SS" != "None" ] || fail "could not resolve a Docker/AL2023 solution stack"
echo "solution stack: $SS"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" -c "ss=$SS" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-enum-added2}" $CLI check "$STACK" --region "$REGION" -c "ss=$SS" | tee "/tmp/cdkrd-$STACK.first.out"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" -c "ss=$SS" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after record"

TABLE_NAME=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId|[0]" --output text)
WINDOW_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::SSM::MaintenanceWindow'].PhysicalResourceId|[0]" --output text)
CD_ROLE_ARN=$(aws deploy get-deployment-group --application-name cdkrd-hunt-cd-0803 --deployment-group-name cdkrd-hunt-dg-0803 --region "$REGION" --query 'deploymentGroupInfo.serviceRoleArn' --output text)

echo "=== [$STACK] OOB-add one child per parent ==="
OOB_TARGET_ID=$(aws ssm register-target-with-maintenance-window --window-id "$WINDOW_ID" \
  --resource-type INSTANCE --targets "Key=tag:cdkrd,Values=oob-0803" --region "$REGION" \
  --query 'WindowTargetId' --output text) || fail "oob register-target"
aws deploy create-deployment-group --application-name cdkrd-hunt-cd-0803 \
  --deployment-group-name cdkrd-oob-dg --service-role-arn "$CD_ROLE_ARN" --region "$REGION" >/dev/null || fail "oob create-deployment-group"
printf 'dummy' > /tmp/cdkrd-oob-bundle.txt && (cd /tmp && rm -f cdkrd-oob-bundle.zip && zip -q cdkrd-oob-bundle.zip cdkrd-oob-bundle.txt)
aws s3 cp /tmp/cdkrd-oob-bundle.zip "s3://$BUNDLE_BUCKET/bundle.zip" --region "$REGION" >/dev/null || fail "oob bundle upload"
aws elasticbeanstalk create-application-version --application-name cdkrd-hunt-eb-0803 \
  --version-label cdkrd-oob-ver --source-bundle "S3Bucket=$BUNDLE_BUCKET,S3Key=bundle.zip" --region "$REGION" >/dev/null || fail "oob create-application-version"
# The OOB policy lands on the POLICY-LESS WriteCapacityUnits target: DynamoDB
# dimensions allow only ONE TargetTracking policy per metric spec (the declared
# read policy occupies the read metric) and reject CustomizedMetricSpecification.
aws application-autoscaling put-scaling-policy --policy-name cdkrd-oob-pol \
  --service-namespace dynamodb --resource-id "table/$TABLE_NAME" \
  --scalable-dimension dynamodb:table:WriteCapacityUnits --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":60,"PredefinedMetricSpecification":{"PredefinedMetricType":"DynamoDBWriteCapacityUtilization"}}' \
  --region "$REGION" >/dev/null || fail "oob put-scaling-policy"

echo "=== [$STACK] check MUST surface all four OOB children as added ==="
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" | tee "/tmp/cdkrd-$STACK.oob.out"
grep -q "$OOB_TARGET_ID" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB MaintenanceWindowTarget not surfaced as added"
grep -q "cdkrd-oob-dg" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB CodeDeploy DeploymentGroup not surfaced as added"
grep -q "cdkrd-oob-ver" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB EB ApplicationVersion not surfaced as added"
grep -q "cdkrd-oob-pol" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB scaling policy not surfaced as added"

echo "=== [$STACK] revert (--remove-unrecorded) MUST delete the four OOB children ==="
$CLI revert "$STACK" --region "$REGION" -c "ss=$SS" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qiE "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence deleting OOB children"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after revert-deleting OOB children"
aws deploy get-deployment-group --application-name cdkrd-hunt-cd-0803 --deployment-group-name cdkrd-oob-dg --region "$REGION" >/dev/null 2>&1 && fail "OOB deployment group still exists after revert"
OOB_TARGET_ID="" # deleted by revert — cleanup must not re-try

echo "=== [$STACK] FN probe: OOB maintenance-window schedule change must be DETECTED then reverted ==="
aws ssm update-maintenance-window --window-id "$WINDOW_ID" --schedule "rate(5 days)" --region "$REGION" >/dev/null || fail "oob update-maintenance-window"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail && fail "schedule drift NOT detected (FN)"
$CLI revert "$STACK" --region "$REGION" -c "ss=$SS" --yes | tee "/tmp/cdkrd-$STACK.revert2.out"
LIVE_SCHED=$(aws ssm get-maintenance-window --window-id "$WINDOW_ID" --region "$REGION" --query 'Schedule' --output text)
[ "$LIVE_SCHED" = "rate(7 days)" ] || fail "revert did not restore schedule (live=$LIVE_SCHED)"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after schedule revert"

echo "=== [$STACK] #1723 fold probe: OOB DeploymentConfigName change must be DETECTED, revert must CONVERGE ==="
aws deploy update-deployment-group --application-name cdkrd-hunt-cd-0803 \
  --current-deployment-group-name cdkrd-hunt-dg-0803 \
  --deployment-config-name CodeDeployDefault.AllAtOnce --region "$REGION" >/dev/null || fail "oob update-deployment-group"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail && fail "DeploymentConfigName drift NOT detected (fold FN)"
$CLI revert "$STACK" --region "$REGION" -c "ss=$SS" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert3.out"
LIVE_CFG=$(aws deploy get-deployment-group --application-name cdkrd-hunt-cd-0803 --deployment-group-name cdkrd-hunt-dg-0803 --region "$REGION" --query 'deploymentGroupInfo.deploymentConfigName' --output text)
[ "$LIVE_CFG" = "CodeDeployDefault.OneAtATime" ] || fail "revert did NOT converge DeploymentConfigName (live=$LIVE_CFG — RSDP candidate)"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after DeploymentConfigName revert"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# Regression integration test (real AWS) for issue #421 TASK 2 — removed-collection
# REVERT on an EC2 Auto Scaling group's `NotificationConfigurations`, which is managed
# by a dedicated sub-API (PutNotificationConfiguration / DeleteNotificationConfiguration).
# deploy -> record -> delete the notification config out of band -> check MUST detect
# (NotificationConfigurations whole-property drift) -> revert MUST re-apply it -> check
# MUST be CLEAN. If Cloud Control UpdateResource cannot re-add the collection, the revert
# step surfaces the gap (closed by an SDK_WRITERS entry).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAsgNotificationRevert
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

ASG=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::AutoScaling::AutoScalingGroup'].PhysicalResourceId" --output text)
TOPIC=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)
[ -n "$ASG" ] || fail "no asg"
[ -n "$TOPIC" ] || fail "no topic"
echo "asg=$ASG topic=$TOPIC"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] notification configs BEFORE removal ==="
aws autoscaling describe-notification-configurations --auto-scaling-group-name "$ASG" --region "$REGION" \
  --query 'NotificationConfigurations[].NotificationType' --output text

echo "=== [$STACK] delete the notification config out of band ==="
aws autoscaling delete-notification-configuration --auto-scaling-group-name "$ASG" \
  --topic-arn "$TOPIC" --region "$REGION" || fail "delete-notification-configuration"

echo "=== [$STACK] check MUST detect the removed NotificationConfigurations ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed NotificationConfigurations not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-apply NotificationConfigurations) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] notification configs AFTER revert ==="
AFTER=$(aws autoscaling describe-notification-configurations --auto-scaling-group-name "$ASG" --region "$REGION" \
  --query 'length(NotificationConfigurations)' --output text)
echo "notification config count after revert=$AFTER"
[ "$AFTER" -ge 1 ] || fail "expected >=1 notification config restored, got $AFTER"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"

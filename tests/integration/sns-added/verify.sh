#!/usr/bin/env bash
# cdk-real-drift `added` integ test for SNS (the THIRD CHILD_ENUMERATORS member).
#   deploy fixture (Topic + Queue + declared SQS subscription) -> record -> check CLEAN
#   -> subscribe the queue AGAIN out of band (aws sns subscribe) -> check reports the
#      subscription under [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots
#      it (proves CC GetResource + normalize work for AWS::SNS::Subscription) -> CLEAN
#   -> add ANOTHER out-of-band subscription -> `revert --remove-unrecorded` DELETES it
#      via Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; the injected subscriptions are removed with the topic.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/sns-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegSnsAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_sub() { # $1 = endpoint queue ARN -> echoes the new SubscriptionArn
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$1" \
    --return-subscription-arn --region "$REGION" --query SubscriptionArn --output text || fail "sns subscribe"
}

queue_arn_by_logical() { # $1 = logical-id prefix -> echoes the queue ARN
  local url
  url="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::SQS::Queue' && starts_with(LogicalResourceId, '$1')].PhysicalResourceId | [0]" \
    --output text)"
  [ -n "$url" ] && [ "$url" != "None" ] || fail "could not resolve queue url for $1"
  aws sqs get-queue-attributes --queue-url "$url" --attribute-names QueueArn --region "$REGION" \
    --query Attributes.QueueArn --output text
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

TOPIC_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)"
[ -n "$TOPIC_ARN" ] || fail "could not resolve Topic arn"
QUEUE_RECORD_ARN="$(queue_arn_by_logical QueueRecord)"
QUEUE_REVERT_ARN="$(queue_arn_by_logical QueueRevert)"

echo "=== subscribe an undeclared queue to the topic out of band ==="
inject_sub "$QUEUE_RECORD_ARN" >/dev/null

echo "=== check reports the subscription as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-sns.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-sns.out || fail "added subscription not under [Potential Drift]"
grep -q "AWS::SNS::Subscription" /tmp/cdkrd-integ-sns.out || fail "the out-of-band subscription not reported"
grep -q "added=" /tmp/cdkrd-integ-sns.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added subscription (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize work for SNS Subscription) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-sns-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added subscription, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-sns-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band subscription (distinct endpoint) for the revert path ==="
SUB2="$(inject_sub "$QUEUE_REVERT_ARN")"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-sns-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-sns-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-sns-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-sns-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second subscription must be gone from AWS ==="
if aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
  --query "Subscriptions[?SubscriptionArn=='$SUB2'].SubscriptionArn" --output text | grep -q .; then
  fail "the reverted subscription still exists (delete did not take effect)"
fi

echo "INTEG PASS"

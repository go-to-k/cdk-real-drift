#!/usr/bin/env bash
# Revert-gap integration test (real AWS): deploy -> record -> mutate the declared
# DefinitionString out of band -> check MUST detect -> revert MUST restore the live
# definition -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSfnDefinitionRevert
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

SM=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::StepFunctions::StateMachine'].PhysicalResourceId" --output text)
[ -n "$SM" ] || fail "no state machine arn"
echo "sm=$SM"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate out of band: update-state-machine definition ==="
ROLE=$(aws stepfunctions describe-state-machine --state-machine-arn "$SM" --region "$REGION" --query roleArn --output text)
aws stepfunctions update-state-machine --state-machine-arn "$SM" --region "$REGION" \
  --definition '{"Comment":"MUTATED","StartAt":"Pass1","States":{"Pass1":{"Type":"Pass","Result":{"v":999},"End":true}}}' \
  --role-arn "$ROLE" >/dev/null || fail "update-state-machine"
sleep 2

echo "=== [$STACK] check MUST detect ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "expected detection (exit !=0), got CLEAN — FALSE NEGATIVE"

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] live definition after revert ==="
LIVE=$(aws stepfunctions describe-state-machine --state-machine-arn "$SM" --region "$REGION" --query definition --output text)
echo "$LIVE" | grep -q '"v":1' || fail "REVERT-GAP: definition not restored after revert (still: $LIVE)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"

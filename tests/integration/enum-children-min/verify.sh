#!/usr/bin/env bash
# Added-children integration test (real AWS), #1540: deploy the five parents
# (ASG / VPC / UserPool / Glue Database / TransitGateway) with declared children
# -> FIRST check (pre-record) must show ZERO drift (declared children NOT
# flagged; TGW default route table excluded) -> out-of-band ScheduledAction +
# hosted-UI domain must surface as `added` -> remove them -> CLEAN again.
# (The full 8-child matrix incl. NAT gateway / flow log / Glue table / TGW
# attachment+route table was live-proven in the 2026-07-13 hunt; this committed
# regression keeps the cheap, fast pair.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713cEnumChildren
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): declared children must NOT flag ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out" && fail "first check must be drift-free (#1540 fixture)"

ASG=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::AutoScaling::AutoScalingGroup'].PhysicalResourceId|[0]" --output text)
POOL=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId|[0]" --output text)

echo "=== [$STACK] out-of-band ScheduledAction + hosted-UI domain MUST surface as added ==="
aws autoscaling put-scheduled-update-group-action --auto-scaling-group-name "$ASG" --scheduled-action-name cdkrd-hunt-oob-sched --recurrence "30 4 * * *" --min-size 0 --max-size 1 --region "$REGION" || fail "oob sched"
aws cognito-idp create-user-pool-domain --domain cdkrd-hunt-oob-verify --user-pool-id "$POOL" --region "$REGION" >/dev/null || fail "oob domain"
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.oob.out"
grep -q "cdkrd-hunt-oob-sched" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB scheduled action not surfaced as added (#1540 regression)"
grep -q "cdkrd-hunt-oob-verify" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB hosted-UI domain not surfaced as added (#1540 regression)"

echo "=== [$STACK] remove the OOB children -> CLEAN again ==="
aws autoscaling delete-scheduled-action --auto-scaling-group-name "$ASG" --scheduled-action-name cdkrd-hunt-oob-sched --region "$REGION" || fail "cleanup sched"
aws cognito-idp delete-user-pool-domain --domain cdkrd-hunt-oob-verify --user-pool-id "$POOL" --region "$REGION" || fail "cleanup domain"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after removing OOB children"

echo "INTEG PASS ($STACK)"

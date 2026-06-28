#!/usr/bin/env bash
# EventBusPolicy detect + revert integration test (real AWS). AWS::Events::EventBusPolicy
# is read fine by Cloud Control (the CFn physical id IS the EventBusName|StatementId
# composite), so detection works — but its live `Statement` comes back as a SINGULAR
# object while classify canonicalizes it to a one-element array, so a Cloud Control
# RFC6902 revert builds an indexed op (`/Statement/0/Action`) the raw model lacks and
# FAILS. This pins the SDK PutPermission writer: deploy -> record -> change the
# statement's Action out of band -> check MUST DETECT -> revert MUST succeed (no
# RFC6902 noSuchPath) -> check MUST be CLEAN and the live Action restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEventBusPolicyReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
BUS="$STACK-bus"
ID="$BUS|AllowSelfPutEvents"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

# poll Cloud Control until the live statement Action equals $1 (the update is async)
wait_action() {
  for _ in $(seq 1 30); do
    cur="$(aws cloudcontrol get-resource --type-name AWS::Events::EventBusPolicy \
      --identifier "$ID" --region "$REGION" --query 'ResourceDescription.Properties' \
      --output text 2>/dev/null)"
    case "$cur" in *"$1"*) return 0 ;; esac
    sleep 3
  done
  return 1
}

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Statement Action events:PutEvents -> events:PutRule ==="
aws cloudcontrol update-resource --type-name AWS::Events::EventBusPolicy --identifier "$ID" \
  --region "$REGION" \
  --patch-document '[{"op":"replace","path":"/Statement/Action","value":"events:PutRule"}]' \
  >/dev/null || fail "inject drift"
wait_action "PutRule" || fail "mutation did not apply"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ebp-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Statement.0.Action" /tmp/cdkrd-ebp-detect.out || fail "Statement.0.Action not reported"

echo "=== revert (write declared statement back via PutPermission) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-ebp-revert.out || fail "revert"
grep -q "FAILED" /tmp/cdkrd-ebp-revert.out && fail "revert reported FAILED (RFC6902 noSuchPath regression)"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live Action MUST be restored to events:PutEvents ==="
wait_action "PutEvents" || fail "live Action not restored to PutEvents"

echo "INTEG PASS ($STACK detect+revert)"

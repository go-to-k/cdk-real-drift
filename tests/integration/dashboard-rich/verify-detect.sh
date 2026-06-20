#!/usr/bin/env bash
# CloudWatch Dashboard detect + revert integration test (real AWS): the "someone
# edited a widget in the console" scenario. Deploy -> record -> overwrite the live
# DashboardBody out of band -> check MUST DETECT the declared drift (exit 1) ->
# revert -> check MUST be CLEAN and the live body MUST be restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDashboardRich
DASH=cdkrd-dashboard-rich
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

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: overwrite DashboardBody (console-edit) ==="
aws cloudwatch put-dashboard --dashboard-name "$DASH" --region "$REGION" \
  --dashboard-body '{"widgets":[{"type":"text","x":0,"y":0,"width":24,"height":2,"properties":{"markdown":"# EDITED IN CONSOLE"}}]}' \
  >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-dashboard-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "DashboardBody" /tmp/cdkrd-dashboard-detect.out || fail "DashboardBody not reported"

echo "=== revert (write declared body back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live body MUST again contain the declared TextWidget markdown ==="
aws cloudwatch get-dashboard --dashboard-name "$DASH" --region "$REGION" \
  --query DashboardBody --output text | grep -q "cdkrd dashboard-rich" \
  || fail "live dashboard body not restored"

echo "INTEG PASS ($STACK detect+revert)"

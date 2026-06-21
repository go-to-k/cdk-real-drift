#!/usr/bin/env bash
# EventBridge Scheduler detect + revert integration test (real AWS): the "someone
# disabled the schedule in the console" scenario. Deploy -> record -> flip the
# DECLARED MUTABLE State ENABLED->DISABLED out of band -> check MUST DETECT (exit 1)
# -> revert -> check MUST be CLEAN and State restored to ENABLED.
#
# `update-schedule` is PUT-style (it replaces the whole schedule), so the out-of-band
# edit re-asserts the SAME config the fixture declares and only flips --state. The
# config values are known from app.ts, so this stays deterministic.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSchedulerRich
NAME=cdkrd-schedule-rich
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

# Resolve the target + role arns the schedule was created with (to re-assert on update).
TARGET_ARN="$(aws scheduler get-schedule --name "$NAME" --region "$REGION" --query 'Target.Arn' --output text)"
ROLE_ARN="$(aws scheduler get-schedule --name "$NAME" --region "$REGION" --query 'Target.RoleArn' --output text)"
[ -n "$TARGET_ARN" ] && [ "$TARGET_ARN" != "None" ] || fail "could not resolve schedule target arn"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: State ENABLED->DISABLED (console-edit) ==="
aws scheduler update-schedule --name "$NAME" --region "$REGION" \
  --schedule-expression "rate(1 hour)" \
  --flexible-time-window Mode=OFF \
  --target "Arn=$TARGET_ARN,RoleArn=$ROLE_ARN" \
  --state DISABLED >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-scheduler-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "State" /tmp/cdkrd-scheduler-detect.out || fail "State not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live State MUST be restored to ENABLED ==="
GOT="$(aws scheduler get-schedule --name "$NAME" --region "$REGION" --query "State" --output text)"
[ "$GOT" = "ENABLED" ] || fail "live State not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

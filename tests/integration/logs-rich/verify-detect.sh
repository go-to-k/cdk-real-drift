#!/usr/bin/env bash
# CloudWatch Logs detect + revert integration test (real AWS): the "someone
# changed the retention in the console" scenario. Deploy -> record -> change the
# DECLARED MUTABLE RetentionInDays (14->30) out of band -> check MUST DETECT
# (exit 1) -> revert -> check MUST be CLEAN and the live value restored to 14.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLogsRich
LG=/cdkrd/logs-rich
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

echo "=== out-of-band: RetentionInDays 14->30 (console-edit) ==="
aws logs put-retention-policy --log-group-name "$LG" --retention-in-days 30 \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-logs-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "RetentionInDays" /tmp/cdkrd-logs-detect.out || fail "RetentionInDays not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live RetentionInDays MUST be restored to 14 ==="
GOT="$(aws logs describe-log-groups --log-group-name-prefix "$LG" --region "$REGION" \
  --query "logGroups[?logGroupName=='$LG'].retentionInDays | [0]" --output text)"
[ "$GOT" = "14" ] || fail "live RetentionInDays not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

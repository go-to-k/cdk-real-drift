#!/usr/bin/env bash
# CloudTrail detect + revert integration test (real AWS): the "someone toggled a
# trail setting in the console" scenario. Deploy -> record -> flip a DECLARED
# MUTABLE prop (IncludeGlobalServiceEvents true->false) out of band -> check MUST
# DETECT (exit 1) -> revert -> check MUST be CLEAN and the live value restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCloudTrailRich
TRAIL=cdkrd-cloudtrail-rich
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

echo "=== out-of-band: IncludeGlobalServiceEvents true->false (console-edit) ==="
aws cloudtrail update-trail --name "$TRAIL" --no-include-global-service-events \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-cloudtrail-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "IncludeGlobalServiceEvents" /tmp/cdkrd-cloudtrail-detect.out || fail "IncludeGlobalServiceEvents not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live IncludeGlobalServiceEvents MUST be restored to true ==="
GOT="$(aws cloudtrail get-trail --name "$TRAIL" --region "$REGION" \
  --query "Trail.IncludeGlobalServiceEvents" --output text)"
[ "$GOT" = "True" ] || fail "live value not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

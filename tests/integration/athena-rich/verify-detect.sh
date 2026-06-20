#!/usr/bin/env bash
# Athena detect + revert integration test (real AWS): the "someone changed it in the
# console" scenario. Deploy -> record -> edit the work group Description out of band
# (a declared, MUTABLE top-level scalar) -> check MUST DETECT the declared drift
# (exit 1) -> revert -> check MUST be CLEAN and the live description MUST be restored.
# The description edit is instant, so this is a fast, reliable detection oracle for a
# declared scalar property.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAthenaRich
REGION="${AWS_REGION:-us-east-1}"
WG=cdkrd-integ-athena-rich
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

echo "=== out-of-band: edit work group description (console-edit) ==="
aws athena update-work-group --work-group "$WG" --region "$REGION" \
  --description "drifted out of band" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-athena-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "Description" /tmp/cdkrd-athena-detect.out || fail "Description drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live description MUST be restored ==="
GOT="$(aws athena get-work-group --work-group "$WG" --region "$REGION" \
  --query "WorkGroup.Description" --output text)"
[ "$GOT" = "cdkrd athena-rich test work group" ] || fail "live description not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

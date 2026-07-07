#!/usr/bin/env bash
# Live-test the REVERT of a folded MUTABLE Location default (PlaceIndex
# DataSourceConfiguration.IntendedUse, folded to {IntendedUse:"SingleUse"} by #609):
#   1. deploy -> check BEFORE record MUST be ZERO potential drift (fold works)
#   2. record baseline
#   3. mutate IntendedUse -> Storage out of band -> check MUST surface it
#      (equality-gate detection preserved)
#   4. revert -> live IntendedUse MUST return to SingleUse + check CLEAN
#      (if UpdatePlaceIndex ignores an omitted DataSourceConfiguration, the `remove`
#       revert is a silent no-op and this fails -> REVERT_SET_DEFAULT_PATHS needed)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLocationPlaceIndexRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
IDX=cdkrd-placeindex-revert

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy ==="
npx cdk deploy -f "$STACK" --require-approval never >/tmp/pir-deploy.log 2>&1 || { tail -30 /tmp/pir-deploy.log; fail "deploy"; }

echo "=== [1] check BEFORE record — MUST be ZERO potential drift ==="
$CLI check "$STACK" --region "$REGION" --fail --verbose | tee /tmp/pir-fresh.out
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected ZERO potential drift on fresh deploy"

echo "=== [2] harvest corpus (fixed binary) ==="
rm -rf /tmp/corpus-pir
CDKRD_CORPUS_DIR=/tmp/corpus-pir $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [3] mutate IntendedUse -> Storage out of band ==="
aws location update-place-index --index-name "$IDX" --data-source-configuration IntendedUse=Storage --region "$REGION" >/dev/null || fail "update-place-index"
$CLI check "$STACK" --region "$REGION" --fail >/tmp/pir-detect.out 2>&1
rc=$?
[ "$rc" -ne 0 ] || { cat /tmp/pir-detect.out; fail "equality-gate FAILED to surface IntendedUse change"; }
grep -qi "DataSourceConfiguration\|IntendedUse" /tmp/pir-detect.out || { cat /tmp/pir-detect.out; fail "detect output missing DataSourceConfiguration"; }
echo "  surfaced IntendedUse=Storage (exit $rc) OK"

echo "=== [4] revert -> live IntendedUse MUST return to SingleUse ==="
$CLI revert "$STACK" --region "$REGION" --yes >/tmp/pir-revert.out 2>&1 || { cat /tmp/pir-revert.out; fail "revert"; }
LIVE_IU=$(aws location describe-place-index --index-name "$IDX" --region "$REGION" --query 'DataSourceConfiguration.IntendedUse' --output text)
echo "  live IntendedUse after revert: $LIVE_IU"
[ "$LIVE_IU" = "SingleUse" ] || fail "revert did NOT converge IntendedUse to SingleUse (got $LIVE_IU) -> REVERT_SET_DEFAULT_PATHS needed"
$CLI check "$STACK" --region "$REGION" --fail >/tmp/pir-postrevert.out 2>&1 || { cat /tmp/pir-postrevert.out; fail "expected CLEAN after revert"; }
echo "  revert -> live SingleUse + CLEAN OK"

echo "INTEG PASS ($STACK)"

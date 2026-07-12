#!/usr/bin/env bash
# False-positive integration test (real AWS): barest Rbin Rule + NetworkManager
# GlobalNetwork + AppRegistry Application. First check (before record) MUST be CLEAN
# (Rbin Status folds atDefault); after record it stays CLEAN; an out-of-band Rbin
# retention change must be detected and revertable (CC UpdateResource, live-proven).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntMiscBarest0712c
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] out-of-band Rbin retention change MUST be detected + revertable ==="
RULEID="$(aws rbin list-rules --resource-type EBS_SNAPSHOT --region "$REGION" \
  --query 'Rules[0].Identifier' --output text)"
aws rbin update-rule --identifier "$RULEID" --region "$REGION" \
  --retention-period RetentionPeriodValue=14,RetentionPeriodUnit=DAYS >/dev/null || fail "rbin update"
$CLI check "$STACK" --region "$REGION" --fail && fail "retention change NOT detected"
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
VAL="$(aws rbin get-rule --identifier "$RULEID" --region "$REGION" \
  --query 'RetentionPeriod.RetentionPeriodValue' --output text)"
[ "$VAL" = "7" ] || fail "retention not restored (got $VAL)"
$CLI check "$STACK" --region "$REGION" --fail || fail "not CLEAN after revert"

echo "INTEG PASS ($STACK)"

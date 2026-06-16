#!/usr/bin/env bash
# cdk-real-drift Route53 record DELETED-out-of-band detection integration test.
#
# Proves WAVE20 gather-F1 (Route53 slice): a declared record deleted out of band while
# its hosted zone SURVIVES is now reported `deleted`, not silently `skipped`. Before the
# fix the SDK-override reader listed the (existing) zone, found no matching record, and
# returned undefined -> the router classified it `skipped` (a coverage gap excluded from
# the drift verdict / --fail), so `check` reported CLEAN / exit 0 and the deletion was
# invisible.
#
# Reuses the weighted-record app (zone + blue + green). Asserts:
#   (1) record + check is CLEAN — BOTH records present are read, NEITHER false-`deleted`
#       (the FP-safety proof: a present record must never be misread as gone).
#   (2) after deleting GREEN out of band (zone + blue untouched), check reports GREEN
#       `deleted` (exit 1) and does NOT report blue as deleted.
# A hosted zone deleted within 12 hours of creation incurs no Route53 charge.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegR53
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
RECORD_NAME="app.cdkrd-r53-integ.internal."

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy hosted zone + two weighted A records (blue=10, green=90) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ZID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Route53::HostedZone'].PhysicalResourceId" --output text)"
[ -n "$ZID" ] || fail "could not resolve hosted zone id"
echo "hostedZone=$ZID"

echo "=== record + check should be CLEAN (both records present -> NEITHER false-deleted) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN — a present record was misread as deleted (FP)"

echo "=== delete GREEN out of band (zone + blue untouched) ==="
aws route53 change-resource-record-sets --hosted-zone-id "$ZID" --region "$REGION" \
  --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":{\"Name\":\"$RECORD_NAME\",\"Type\":\"A\",\"SetIdentifier\":\"green\",\"Weight\":90,\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"2.2.2.2\"}]}}]}" \
  >/dev/null || fail "change-resource-record-sets DELETE"

echo "=== check MUST report GREEN deleted (and NOT blue) ==="
OUT=/tmp/cdkrd-r53-deleted.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for the deleted GREEN record, got $rc (was it skipped?)"
grep -qi "deleted" "$OUT" || fail "no deleted finding reported for the out-of-band-removed record"
grep -qi "Green" "$OUT" || fail "the deletion was not attributed to the Green record"
grep -qi "Blue.*deleted\|deleted.*Blue" "$OUT" && fail "blue (still present) was falsely reported deleted"

echo "INTEG PASS"

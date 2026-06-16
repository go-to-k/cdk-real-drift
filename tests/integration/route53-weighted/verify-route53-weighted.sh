#!/usr/bin/env bash
# cdk-real-drift Route53 weighted-record WRONG-MATCH false-positive/negative integration test.
#
# The SDK-override reader fetched ListResourceRecordSets with MaxItems:1 and matched on
# Type+Name only, so for a name+type with multiple routing variants (weighted/latency/
# failover/geo, distinguished by SetIdentifier) it read whichever record came first for
# EVERY declared variant — comparing one record's declared values against another's live
# values (false drift), or missing the record entirely. The fix drops MaxItems:1 and
# disambiguates by SetIdentifier, and projects the routing fields (Weight/Failover/...).
#
# This deploys a public hosted zone with two weighted A records sharing Name+Type
# (blue weight 10, green weight 90). It asserts:
#   (1) record + check is CLEAN — pre-fix, green (declared weight 90) would have matched
#       blue (live weight 10) and reported a WRONG-record false positive.
#   (2) an out-of-band change to GREEN's weight (90 -> 50) is detected ON GREEN, proving
#       the correct record is read (not blue, whose weight 10 is untouched).
# A hosted zone deleted within 12 hours of creation incurs no Route53 charge.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegR53
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ZONE_NAME="app.cdkrd-r53-integ.internal."

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

echo "=== record + check should be CLEAN (no wrong-record FP: green must match green, not blue) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
OUT0=/tmp/cdkrd-r53-clean.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT0"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN — green (declared weight 90) likely matched blue (live 10): wrong-record FP"

echo "=== change GREEN weight out of band (90 -> 50); blue untouched ==="
aws route53 change-resource-record-sets --hosted-zone-id "$ZID" --region "$REGION" \
  --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$ZONE_NAME\",\"Type\":\"A\",\"SetIdentifier\":\"green\",\"Weight\":50,\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"2.2.2.2\"}]}}]}" \
  >/dev/null || fail "change-resource-record-sets"

echo "=== check MUST detect the GREEN weight change (proves the right record is read) ==="
OUT=/tmp/cdkrd-r53-drift.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for green weight change, got $rc"
grep -qi "Weight" "$OUT" || fail "Weight drift not reported — routing field projected away?"
grep -qi "Green" "$OUT" || fail "drift not attributed to the Green record — wrong record matched?"

echo "INTEG PASS"

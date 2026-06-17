#!/usr/bin/env bash
# cdk-real-drift AWS::Route53::RecordSet GeoProximityLocation projection FALSE-NEGATIVE test.
#
# The Route53 SDK-override reader projected the simpler routing fields but OMITTED
# GeoProximityLocation (and CidrRoutingConfig) — so an out-of-band change to a geoproximity
# record's region/bias was undetectable. The fix projects it. This deploys a geoproximity
# record declaring ONLY AWSRegion (AWS sets Bias=0), asserts CLEAN after record (FP guard:
# the live Bias=0 folds via KNOWN_DEFAULT_PATHS), then adds a Bias out of band and asserts
# cdkrd DETECTS it.
#
# ROBUST TEARDOWN: a Route53 hosted zone is not deletable while it holds non-default records,
# and an out-of-band-modified record once orphaned a zone (billing). After delstack, this
# script EXPLICITLY sweeps any surviving zone (deletes every non-SOA/NS record, then the
# zone) so nothing is ever left behind.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRoute53Geo
REGION="${AWS_REGION:-us-east-1}"
ZONE_NAME="geoproximity.cdkrd-integ-test.com."
REC_NAME="geo.geoproximity.cdkrd-integ-test.com."
CLI="node $ROOT/dist/cli.js"

sweep_zone() {
  # Belt-and-suspenders: delete any surviving hosted zone by name (Route53 is global).
  local zid
  zid="$(aws route53 list-hosted-zones --query "HostedZones[?Name=='$ZONE_NAME'].Id" --output text 2>/dev/null | head -1)"
  [ -n "$zid" ] && [ "$zid" != "None" ] || return 0
  echo "sweeping orphan zone $zid"
  local batch
  batch="$(aws route53 list-resource-record-sets --hosted-zone-id "$zid" --output json 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); c=[{"Action":"DELETE","ResourceRecordSet":r} for r in d.get("ResourceRecordSets",[]) if r.get("Type") not in ("SOA","NS")]; print(json.dumps({"Changes":c}) if c else "")')"
  if [ -n "$batch" ]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$zid" --change-batch "$batch" >/dev/null 2>&1 || true
  fi
  aws route53 delete-hosted-zone --id "$zid" >/dev/null 2>&1 || true
}

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  sweep_zone
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy hosted zone + geoproximity record (AWSRegion only, no Bias) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ZID="$(aws route53 list-hosted-zones --query "HostedZones[?Name=='$ZONE_NAME'].Id" --output text | head -1)"
[ -n "$ZID" ] && [ "$ZID" != "None" ] || fail "could not resolve hosted zone id"
echo "zone=$ZID"

echo "=== record + check should be CLEAN (FP guard: live Bias=0 folds via KNOWN_DEFAULT_PATHS) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after record — GeoProximityLocation/Bias leaked as drift?"

echo "=== add a Bias out of band — must DETECT GeoProximityLocation.Bias ==="
# UPSERT the same record (same name/type/set-id) with a non-zero Bias.
BATCH="$(python3 -c 'import json; print(json.dumps({"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$REC_NAME"'","Type":"A","SetIdentifier":"g1","TTL":60,"ResourceRecords":[{"Value":"1.2.3.4"}],"GeoProximityLocation":{"AWSRegion":"us-east-1","Bias":50}}}]}))')"
aws route53 change-resource-record-sets --hosted-zone-id "$ZID" --change-batch "$BATCH" >/dev/null \
  || fail "change-resource-record-sets (set bias)"

OUT=/tmp/cdkrd-route53-geo.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for out-of-band GeoProximityLocation Bias, got $rc"
grep -qi "Bias" "$OUT" || fail "out-of-band GeoProximityLocation.Bias not reported — still projected away?"

echo "INTEG PASS"

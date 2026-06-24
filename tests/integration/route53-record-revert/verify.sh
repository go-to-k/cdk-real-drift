#!/usr/bin/env bash
# Route53 RecordSet detect->revert->clean (real AWS, mutating). Proves the new
# writeRoute53RecordSet (ChangeResourceRecordSets UPSERT) reverts an out-of-band TTL edit.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegRoute53RecordRevert; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
REC=www.cdkrd-revert-x9z7q.com
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
ZID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Route53::HostedZone'].PhysicalResourceId" --output text)"
[ -n "$ZID" ] || fail "could not resolve hosted zone id"
echo "zone=$ZID record=$REC"
echo "=== record + check CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"
echo "=== mutate TTL 300 -> 60 out of band (UPSERT) ==="
aws route53 change-resource-record-sets --hosted-zone-id "$ZID" --region "$REGION" --change-batch \
  '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$REC"'","Type":"A","TTL":60,"ResourceRecords":[{"Value":"203.0.113.10"}]}}]}' >/dev/null || fail "out-of-band change"
sleep 5
echo "=== check DETECTS (exit 1, TTL) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/r53-pre.out; [ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "TTL" /tmp/r53-pre.out || fail "TTL drift not reported"
echo "=== revert --yes ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/r53-rev.out || fail "revert non-zero"
sleep 5
echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert (revert no-op bug)"
echo "=== confirm live TTL restored to 300 ==="
GOT="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZID" --region "$REGION" --query "ResourceRecordSets[?Name=='$REC.'&&Type=='A'].TTL | [0]" --output text)"
[ "$GOT" = "300" ] || fail "live TTL not restored (got: $GOT)"
echo "INTEG PASS ($STACK)"

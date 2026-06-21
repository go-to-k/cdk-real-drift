#!/usr/bin/env bash
# Firehose DeliveryStream detect + revert (real AWS): bump the declared MUTABLE nested
# ExtendedS3DestinationConfiguration.BufferingHints.IntervalInSeconds 300->600 out of
# band (update-destination) -> check MUST DETECT -> revert (CC) -> CLEAN + restored.
# Proves Cloud Control UpdateResource handles the nested destination patch (no Class-2
# re-validation conflict, unlike CloudFront/WAFv2/Glue).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegFirehoseRich; DS=cdkrd-firehose-rich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out fh.json fhu.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob BufferingHints.IntervalInSeconds 300->600 (update-destination) ==="
aws firehose describe-delivery-stream --delivery-stream-name "$DS" --region "$REGION" > fh.json
VID="$(node -e "console.log(require('./fh.json').DeliveryStreamDescription.VersionId)")"
DID="$(node -e "console.log(require('./fh.json').DeliveryStreamDescription.Destinations[0].DestinationId)")"
node -e "const d=require('./fh.json').DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription;const u={RoleARN:d.RoleARN,BucketARN:d.BucketARN,Prefix:d.Prefix,ErrorOutputPrefix:d.ErrorOutputPrefix,BufferingHints:{IntervalInSeconds:600,SizeInMBs:d.BufferingHints.SizeInMBs},CompressionFormat:d.CompressionFormat};require('fs').writeFileSync('fhu.json',JSON.stringify(u));"
aws firehose update-destination --delivery-stream-name "$DS" --current-delivery-stream-version-id "$VID" --destination-id "$DID" --extended-s3-destination-update file://fhu.json --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-fh-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "IntervalInSeconds" /tmp/cdkrd-fh-detect.out || fail "buffering drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws firehose describe-delivery-stream --delivery-stream-name "$DS" --region "$REGION" --query 'DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription.BufferingHints.IntervalInSeconds' --output text)"
[ "$GOT" = "300" ] || fail "interval not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

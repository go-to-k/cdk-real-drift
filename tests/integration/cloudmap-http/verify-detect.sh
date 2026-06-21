#!/usr/bin/env bash
# Cloud Map detect + revert integration test (real AWS): the "someone edited the
# namespace in the console" scenario. AWS::ServiceDiscovery::HttpNamespace is a Cloud
# Control read+write gap, so detection relies on the GetNamespace SDK override and
# revert on the UpdateHttpNamespace SDK writer. Deploy -> record -> flip the DECLARED
# MUTABLE Description out of band -> check MUST DETECT (exit 1) -> revert -> check MUST
# be CLEAN and the Description restored.
#
# NOTE: the namespace Description is the mutable subject because a service in an
# HTTP/API-only namespace is immutable (UpdateService -> InvalidInput), so only the
# namespace can drift here.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCloudmapHttp
NS_NAME=cdkrd-cloudmap-http
DESIRED="cdkrd cloud map http namespace"
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

NSID="$(aws servicediscovery list-namespaces --region "$REGION" \
  --query "Namespaces[?Name=='$NS_NAME'].Id" --output text)"
[ -n "$NSID" ] && [ "$NSID" != "None" ] || fail "could not resolve namespace id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Description -> DRIFTED (console-edit) ==="
aws servicediscovery update-http-namespace --region "$REGION" --id "$NSID" \
  --namespace "Description=DRIFTED OUT OF BAND" --query OperationId --output text >/dev/null \
  || fail "inject drift"
sleep 5

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-cloudmap-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "Description" /tmp/cdkrd-cloudmap-detect.out || fail "Description not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
sleep 4

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live Description MUST be restored ==="
GOT="$(aws servicediscovery get-namespace --region "$REGION" --id "$NSID" \
  --query "Namespace.Description" --output text)"
[ "$GOT" = "$DESIRED" ] || fail "live Description not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

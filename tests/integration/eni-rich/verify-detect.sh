#!/usr/bin/env bash
# ENI detect + revert integration test (real AWS): the false-NEGATIVE half. Deploy ->
# record -> flip the DECLARED MUTABLE SourceDestCheck out of band (console-edit
# scenario via modify-network-interface-attribute) -> check MUST DETECT the declared
# drift (exit 1) -> revert -> check MUST be CLEAN and the live SourceDestCheck MUST be
# restored to true.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEniRich
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

ENI="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::NetworkInterface'].PhysicalResourceId" --output text)"
[ -n "$ENI" ] || fail "could not resolve network interface id"
echo "eni=$ENI"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: disable SourceDestCheck (console-edit) ==="
aws ec2 modify-network-interface-attribute --network-interface-id "$ENI" \
  --no-source-dest-check --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-eni-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "SourceDestCheck" /tmp/cdkrd-eni-detect.out || fail "SourceDestCheck not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live SourceDestCheck MUST be restored to true ==="
GOT="$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI" --region "$REGION" \
  --query "NetworkInterfaces[0].SourceDestCheck" --output text)"
[ "$GOT" = "True" ] || fail "live SourceDestCheck not restored (got: [$GOT], want: True)"

echo "INTEG PASS ($STACK detect+revert)"

#!/usr/bin/env bash
# Detect + revert integration test (real AWS): flip a VPCEndpointService's
# AcceptanceRequired out of band (true -> false, the classic "quietly opened up a
# PrivateLink service" console change). check MUST DETECT the declared drift
# (exit 1) -> revert -> check MUST be CLEAN and the live flag restored to true.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegVpcLinkEndpointSvc
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

SVC="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::VPCEndpointService'].PhysicalResourceId" --output text)"
[ -n "$SVC" ] || fail "could not resolve endpoint service physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: AcceptanceRequired true -> false (console-edit) ==="
aws ec2 modify-vpc-endpoint-service-configuration --service-id "$SVC" --region "$REGION" \
  --no-acceptance-required >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "AcceptanceRequired" "/tmp/cdkrd-$STACK-detect.out" || fail "AcceptanceRequired drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE="$(aws ec2 describe-vpc-endpoint-service-configurations --service-ids "$SVC" --region "$REGION" \
  --query 'ServiceConfigurations[0].AcceptanceRequired' --output text)"
[ "$LIVE" = "True" ] || fail "live AcceptanceRequired not restored (got $LIVE)"

echo "INTEG PASS ($STACK detect+revert)"

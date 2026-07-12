#!/usr/bin/env bash
# False-positive + detection + revert-convergence integration test (real AWS),
# #1544/#1545: barest t4g.nano instance (NIC-inline SG shape) -> FIRST check must
# show ZERO drift -> record -> out-of-band IMDSv2 DOWNGRADE must be DETECTED ->
# revert must CONVERGE the live HttpTokens back to required (the one-shot
# ModifyInstanceMetadataOptions API ignores a bare remove).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713bImds
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): every drift line is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out" && fail "first check must be drift-free (#1545 NIC SG echo regression)"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

IID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::EC2::Instance'].PhysicalResourceId|[0]" --output text)
[ -n "$IID" ] && [ "$IID" != "None" ] || fail "resolve instance id"

echo "=== [$STACK] out-of-band IMDSv2 downgrade MUST be detected ==="
aws ec2 modify-instance-metadata-options --instance-id "$IID" --http-tokens optional --region "$REGION" >/dev/null || fail "mutate"
$CLI check "$STACK" --region "$REGION" --fail
[ "$?" -eq 1 ] || fail "expected drift exit 1 after IMDSv2 downgrade"

echo "=== [$STACK] revert MUST converge live HttpTokens back to required (#1544) ==="
$CLI revert "$STACK" --region "$REGION" --remove-unrecorded --yes || fail "revert"
V=$(aws ec2 describe-instances --instance-ids "$IID" --region "$REGION" --query 'Reservations[0].Instances[0].MetadataOptions.HttpTokens' --output text)
[ "$V" = "required" ] || fail "live HttpTokens is $V, expected required — #1544 silent no-op regression"

echo "INTEG PASS ($STACK)"

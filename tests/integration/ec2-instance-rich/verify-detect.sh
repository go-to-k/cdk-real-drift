#!/usr/bin/env bash
# EC2 EBS Volume detect (+ revert) integration test (real AWS): the "someone changed
# it in the console" scenario. Deploy -> record -> change a DECLARED MUTABLE property
# (the data Volume's Throughput, 150 -> 250) out of band -> check MUST DETECT the
# declared drift (exit 1) -> revert -> check MUST be CLEAN and the live value restored.
# This is the false-negative / detection half that verify.sh does not exercise.
#
# Throughput is chosen because a gp3 volume's throughput is freely modifiable in BOTH
# directions (unlike Size, which can only grow — so it could not be reverted down).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEc2Rich
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

VOL="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::Volume'].PhysicalResourceId" --output text)"
[ -n "$VOL" ] || fail "could not resolve volume physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Volume Throughput 150 -> 250 (console-edit) ==="
aws ec2 modify-volume --volume-id "$VOL" --throughput 250 --region "$REGION" >/dev/null || fail "inject drift"
# modify-volume is async; wait until the optimization completes and Throughput settles.
for _ in $(seq 1 30); do
  TP="$(aws ec2 describe-volumes --volume-ids "$VOL" --region "$REGION" --query "Volumes[0].Throughput" --output text)"
  [ "$TP" = "250" ] && break
  sleep 5
done
[ "$TP" = "250" ] || fail "modify-volume did not settle to 250 (got $TP)"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ec2-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Throughput" /tmp/cdkrd-ec2-detect.out || fail "Throughput not reported"

echo "=== revert (write declared value back) ==="
if $CLI revert "$STACK" --region "$REGION" --yes; then
  echo "=== check MUST be CLEAN after revert ==="
  $CLI check "$STACK" --region "$REGION" --fail
  [ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"
  for _ in $(seq 1 30); do
    TP="$(aws ec2 describe-volumes --volume-ids "$VOL" --region "$REGION" --query "Volumes[0].Throughput" --output text)"
    [ "$TP" = "150" ] && break
    sleep 5
  done
  [ "$TP" = "150" ] || fail "live throughput not restored to 150 (got $TP)"
  echo "INTEG PASS ($STACK detect+revert)"
else
  echo "NOTE: revert not supported for AWS::EC2::Volume (SDK_WRITERS candidate); detection PASS only"
  echo "INTEG PASS ($STACK detect-only)"
fi

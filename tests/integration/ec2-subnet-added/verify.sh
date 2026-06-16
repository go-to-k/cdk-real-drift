#!/usr/bin/env bash
# cdk-real-drift `added` integ test for EC2 (the TENTH CHILD_ENUMERATORS member).
#   deploy fixture (minimal VPC + CDK public subnet) -> record -> CLEAN
#   -> create-subnet an undeclared subnet in the SAME VPC out of band -> check reports the
#      subnet under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it
#      (proves CC GetResource + normalize for AWS::EC2::Subnet) -> CLEAN
#   -> add ANOTHER out-of-band subnet -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap removes the
# out-of-band subnets off the VPC FIRST (else they block the VPC's deletion -> the stack
# goes DELETE_FAILED) and then destroys the stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/ec2-subnet-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEc2SubnetAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

resolve_vpc() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" \
    --output text 2>/dev/null
}

cleanup() {
  echo "--- cleanup ---"
  # An out-of-band subnet we recorded (but did not revert) lingers in the VPC and BLOCKS
  # the VPC's deletion (CFn cannot delete a VPC that still has subnets) -> the stack goes
  # DELETE_FAILED, and delstack only sees STACK members, not a stack-external subnet sitting
  # in a member VPC. So sweep any out-of-band subnets (the injected 10.0.20x.0/24 ones) off
  # the VPC FIRST.
  local vpc
  vpc="$(resolve_vpc)"
  if [ -n "$vpc" ] && [ "$vpc" != "None" ]; then
    for sn in $(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=vpc-id,Values=$vpc" "Name=cidr-block,Values=10.0.200.0/24,10.0.201.0/24" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "$sn" --region "$REGION" >/dev/null 2>&1 || true
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_subnet() { # $1 = cidr -> creates a subnet in the VPC, echoes the SubnetId
  aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$1" --region "$REGION" \
    --query Subnet.SubnetId --output text || fail "create-subnet $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

VPC="$(resolve_vpc)"
[ -n "$VPC" ] && [ "$VPC" != "None" ] || fail "could not resolve VPC id"

echo "=== create an undeclared subnet in the VPC out of band ==="
SN1="$(inject_subnet 10.0.200.0/24)"
[ -n "$SN1" ] || fail "no SubnetId for the first injected subnet"

echo "=== check reports the subnet as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-ec2.out || fail "added subnet not under [Not Recorded]"
grep -q "AWS::EC2::Subnet" /tmp/cdkrd-integ-ec2.out || fail "the out-of-band subnet not reported"
grep -q "added=" /tmp/cdkrd-integ-ec2.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added subnet (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for EC2::Subnet) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added subnet, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-ec2-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band subnet for the revert path ==="
SN2="$(inject_subnet 10.0.201.0/24)"
[ -n "$SN2" ] || fail "no SubnetId for the second injected subnet"

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-ec2-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-ec2-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-ec2-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second subnet must be gone from AWS ==="
if aws ec2 describe-subnets --subnet-ids "$SN2" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted subnet still exists (delete did not take effect)"
fi

echo "INTEG PASS"

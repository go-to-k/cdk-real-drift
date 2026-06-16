#!/usr/bin/env bash
# cdk-real-drift `added` integ test for EC2 route tables (the ELEVENTH CHILD_ENUMERATORS
# member).
#   deploy fixture (minimal VPC + public subnet -> CDK route table with a declared
#     0.0.0.0/0 -> IGW route + the auto VPC-local route) -> record -> CLEAN (proves the
#     declared 0.0.0.0/0 route and the local route are NOT flagged added)
#   -> create-route an undeclared route in the SAME route table out of band -> check
#      reports it under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it
#      (proves CC GetResource on the composite RouteTableId|CidrBlock) -> CLEAN
#   -> add ANOTHER out-of-band route -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). Deleting the route table
# (with the VPC) removes its routes, so an out-of-band route does NOT block teardown; the
# standard cleanup trap destroys the stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/ec2-route-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEc2RouteAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting the route table (with the VPC) removes its routes, so an out-of-band route does
  # NOT block the VPC's deletion. Just destroy the stack.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_route() { # $1 = cidr -> creates a route in the public route table to the IGW
  aws ec2 create-route --route-table-id "$RT" --destination-cidr-block "$1" \
    --gateway-id "$IGW" --region "$REGION" >/dev/null || fail "create-route $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== resolve the public route table id + the internet gateway id ==="
RT="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::RouteTable'].PhysicalResourceId | [0]" \
  --output text 2>/dev/null)"
[ -n "$RT" ] && [ "$RT" != "None" ] || fail "could not resolve route table id"
IGW="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::InternetGateway'].PhysicalResourceId | [0]" \
  --output text 2>/dev/null)"
[ -n "$IGW" ] && [ "$IGW" != "None" ] || fail "could not resolve internet gateway id"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared 0.0.0.0/0 + local route NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== create an undeclared route in the route table out of band ==="
inject_route 10.99.0.0/16

echo "=== check reports the route as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2route.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-ec2route.out || fail "added route not under [Not Recorded]"
grep -q "AWS::EC2::Route" /tmp/cdkrd-integ-ec2route.out || fail "the out-of-band route not reported"
grep -q "added=" /tmp/cdkrd-integ-ec2route.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added route (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on RouteTableId|CidrBlock) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2route-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added route, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-ec2route-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band route for the revert path ==="
inject_route 10.98.0.0/16

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ec2route-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-ec2route-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-ec2route-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-ec2route-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second route must be gone from AWS ==="
left="$(aws ec2 describe-route-tables --route-table-ids "$RT" --region "$REGION" \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='10.98.0.0/16']" --output json 2>/dev/null)"
[ "$left" = "[]" ] || fail "the reverted route still exists (delete did not take effect): $left"

echo "INTEG PASS"

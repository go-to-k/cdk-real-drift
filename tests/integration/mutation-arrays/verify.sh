#!/usr/bin/env bash
# cdk-real-drift array/policy MUTATION integration test (real AWS, R94).
#
# The highest-yield false-negative hunt: each property's normalizer sorts or
# canonicalizes an array/policy (the class where the R88 bugs lived). Add an element
# out of band and assert `check` DETECTS it — proving the normalization does not
# OVER-suppress and silently hide a real change.
#   - IAM inline policy: add an Action (policy canonicalization);
#   - SecurityGroup: add an ingress rule (R88 object-array sort);
#   - WAFv2 IPSet: add an address (R84 scalar-set).
# A cleanup trap destroys even on failure.
#
# Usage:  cd tests/integration/mutation-arrays && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMutationArrays
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }
phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text
}

echo "=== build + deploy + record (CLEAN baseline) ==="
(cd "$ROOT" && vp run build) || fail "build"
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"

echo "=== add an element to each array/policy out of band ==="
ROLE="$(phys AWS::IAM::Role)";          [ -n "$ROLE" ] || fail "no role"
SGID="$(phys AWS::EC2::SecurityGroup)"; [ -n "$SGID" ] || fail "no sg id"
IPSET="$(phys AWS::WAFv2::IPSet)";      [ -n "$IPSET" ] || fail "no ipset"
IPSET_ID="$(echo "$IPSET" | awk -F'|' '{print $2}')"
IPSET_NAME="$(echo "$IPSET" | awk -F'|' '{print $1}')"

# IAM inline policy: add a second Action
aws iam put-role-policy --role-name "$ROLE" --policy-name P \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:DeleteObject"],"Resource":"*"}]}' \
  || fail "mutate iam policy"

# SecurityGroup: add an SSH ingress rule
aws ec2 authorize-security-group-ingress --group-id "$SGID" \
  --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=203.0.113.0/24,Description=ssh}]' \
  --region "$REGION" >/dev/null || fail "mutate sg"

# WAFv2 IPSet: add a third address (needs the current lock token)
LOCK="$(aws wafv2 get-ip-set --scope REGIONAL --name "$IPSET_NAME" --id "$IPSET_ID" --region "$REGION" --query 'LockToken' --output text)"
[ -n "$LOCK" ] || fail "no ipset lock token"
aws wafv2 update-ip-set --scope REGIONAL --name "$IPSET_NAME" --id "$IPSET_ID" --lock-token "$LOCK" \
  --addresses 192.0.2.0/24 198.51.100.0/24 203.0.113.0/24 --region "$REGION" >/dev/null || fail "mutate ipset"
sleep 5

echo "=== check must DETECT every array/policy addition (no over-suppression) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mut-arrays.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc — an array/policy change was MISSED"
grep -q "Policies" /tmp/cdkrd-mut-arrays.out || fail "IAM inline-policy Action addition NOT detected (policy canon over-suppressed)"
grep -q "SecurityGroupIngress" /tmp/cdkrd-mut-arrays.out || fail "SG ingress rule addition NOT detected (R88 sort over-suppressed)"
grep -q "Addresses" /tmp/cdkrd-mut-arrays.out || fail "WAFv2 IPSet address addition NOT detected (R84 set over-suppressed)"

echo "INTEG PASS"

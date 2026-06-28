#!/usr/bin/env bash
# Regression integration test (real AWS) for the OMITTED_WHEN_EMPTY_PATHS fix:
# AWS's Cloud Control read OMITS SecurityGroupIngress when there are no rules, so a
# declared rule removed out of band (the "someone deleted the SSH rule in the
# console" scenario) used to classify as a readGap -> CLEAN -> SILENT FALSE NEGATIVE.
# deploy -> record -> revoke the only ingress rule -> check MUST detect -> revert MUST
# re-authorize it -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSgIngressRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

GNAME=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" --output text)
SGID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$GNAME" --region "$REGION" \
  --query 'SecurityGroups[0].GroupId' --output text)
[ -n "$SGID" ] && [ "$SGID" != "None" ] || fail "no sg id (name=$GNAME)"
echo "sg=$SGID"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] revoke the only ingress rule (CC will omit SecurityGroupIngress) ==="
aws ec2 revoke-security-group-ingress --group-id "$SGID" --region "$REGION" \
  --protocol tcp --port 22 --cidr 10.0.0.0/16 >/dev/null || fail "revoke"

echo "=== [$STACK] check MUST detect the removed rule (regression: was a readGap FN) ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed ingress rule not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-authorize the rule) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] live ingress after revert ==="
N=$(aws ec2 describe-security-groups --group-ids "$SGID" --region "$REGION" \
  --query 'length(SecurityGroups[0].IpPermissions)' --output text)
[ "$N" = "1" ] || fail "revert did not restore the ingress rule (rule count=$N)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"

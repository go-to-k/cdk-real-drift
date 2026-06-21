#!/usr/bin/env bash
# cdkrd UNEXPECTED-ATTACH detection integration test (real AWS, AWS-mutating).
# Proves the OTHER half of ManagedPolicy attachment tiering: a live-only attachment
# (a member NOT declared) is surfaced as UNDECLARED inventory, so after `record` a NEW,
# unexpected attachment (e.g. a console/rogue grant of the policy to another principal)
# is DETECTED as drift vs the baseline — something cdk drift only matches by ALSO
# false-drifting every legitimate union member.
# Flow: create 2 standalone roles (declaredRole, intruderRole) -> deploy a ManagedPolicy
# declaring roles:[declaredRole] -> record (baseline, intruder NOT yet attached) ->
# check CLEAN -> attach intruderRole out of band (the unexpected grant) -> check DETECTS
# it (undeclared, appeared since record, exit 1) -> destroy + delete both roles.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamManagedPolicyDetach
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
SUFFIX="$$"
DECLARED_ROLE="cdkrd-mpa-declared-$SUFFIX"
INTRUDER_ROLE="cdkrd-mpa-intruder-$SUFFIX"
ASSUME='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

MANAGED_ARN=""
cleanup() {
  echo "--- cleanup ---"
  if [ -n "$MANAGED_ARN" ]; then
    aws iam detach-role-policy --role-name "$DECLARED_ROLE" --policy-arn "$MANAGED_ARN" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "$INTRUDER_ROLE" --policy-arn "$MANAGED_ARN" >/dev/null 2>&1 || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$DECLARED_ROLE" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$INTRUDER_ROLE" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp pack) || fail build

echo "=== create 2 standalone roles ==="
DECLARED_ARN="$(aws iam create-role --role-name "$DECLARED_ROLE" --assume-role-policy-document "$ASSUME" \
  --query 'Role.Arn' --output text)" || fail "create declared role"
aws iam create-role --role-name "$INTRUDER_ROLE" --assume-role-policy-document "$ASSUME" >/dev/null \
  || fail "create intruder role"
echo "declaredRole=$DECLARED_ROLE intruderRole=$INTRUDER_ROLE"
sleep 8

echo "=== deploy (ManagedPolicy declares roles:[declaredRole]) ==="
npx cdk deploy -f "$STACK" -c "declaredRoleArn=$DECLARED_ARN" --require-approval never || fail deploy

MANAGED_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::ManagedPolicy'].PhysicalResourceId" --output text)"
[ -n "$MANAGED_ARN" ] || fail "could not resolve managed policy ARN"

echo "=== record (baseline — intruder NOT attached yet) ==="
$CLI record "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --yes || fail record

echo "=== check CLEAN ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail
[ $? -eq 0 ] || fail "expected CLEAN after record"

echo "=== attach intruderRole out of band (the unexpected grant) ==="
aws iam attach-role-policy --role-name "$INTRUDER_ROLE" --policy-arn "$MANAGED_ARN" || fail "attach intruder"
echo "(waiting for IAM propagation)"; sleep 12

echo "=== check DETECTS the unexpected attachment (exit 1) ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail | tee /tmp/cdkrd-mpa.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1 for the unexpected attach"
grep -q "$INTRUDER_ROLE" /tmp/cdkrd-mpa.out || fail "intruder attachment not reported"
grep -q "appeared since record" /tmp/cdkrd-mpa.out || fail "not flagged as appeared-since-record drift"

echo "=== revert --remove-unrecorded --yes (DETACH the unexpected member) ==="
$CLI revert "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --remove-unrecorded --yes \
  | tee /tmp/cdkrd-mpa-revert.out || fail "revert returned non-zero"
grep -qi "no physical id\|not revertable" /tmp/cdkrd-mpa-revert.out && fail "intruder reported not-revertable"
echo "(waiting for IAM propagation)"; sleep 10

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail
[ $? -eq 0 ] || fail "drift remains after revert"

echo "=== confirm the intruder is DETACHED and the declared role untouched ==="
AFTER="$(aws iam list-entities-for-policy --policy-arn "$MANAGED_ARN" --region "$REGION" \
  --query 'PolicyRoles[].RoleName' --output text)"
echo "post-revert attached roles: $AFTER"
echo "$AFTER" | tr '\t' '\n' | grep -qx "$INTRUDER_ROLE" && fail "intruder still attached (detach did not run)"
echo "$AFTER" | tr '\t' '\n' | grep -qx "$DECLARED_ROLE" || fail "declared role was wrongly detached"

echo "INTEG PASS (CdkRealDriftIntegIamManagedPolicyDetach unexpected-attach detect + --remove-unrecorded detach)"

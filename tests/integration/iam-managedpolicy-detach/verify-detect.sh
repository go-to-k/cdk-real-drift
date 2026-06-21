#!/usr/bin/env bash
# cdkrd IAM ManagedPolicy ATTACHMENT-DETACH integration test (real AWS, AWS-mutating).
# Proves the asymmetric subset detach detection end-to-end, ISOLATED from the role-side
# ManagedPolicyArns mirror by attaching the policy to roles created OUTSIDE the stack:
#   create 2 standalone roles (declaredRole, unionRole) -> deploy a ManagedPolicy that
#   DECLARES roles:[declaredRole] -> attach unionRole out of band (the live UNION
#   member) -> record -> check CLEAN (unionRole ignored: NO false positive — the case
#   cdk drift gets wrong) -> detach declaredRole out of band -> check DETECTS the detach
#   (declared∖live, exit 1) -> revert --yes re-attaches declaredRole ONLY
#   (AttachRolePolicy) -> check CLEAN -> direct AWS read confirms declaredRole
#   re-attached AND unionRole untouched -> destroy + delete both roles.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamManagedPolicyDetach
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
SUFFIX="$$"
DECLARED_ROLE="cdkrd-mpd-declared-$SUFFIX"
UNION_ROLE="cdkrd-mpd-union-$SUFFIX"
ASSUME='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

MANAGED_ARN=""
cleanup() {
  echo "--- cleanup ---"
  # detach the policy from both roles (so role + stack deletion never blocks)
  if [ -n "$MANAGED_ARN" ]; then
    aws iam detach-role-policy --role-name "$DECLARED_ROLE" --policy-arn "$MANAGED_ARN" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "$UNION_ROLE" --policy-arn "$MANAGED_ARN" >/dev/null 2>&1 || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$DECLARED_ROLE" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$UNION_ROLE" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp pack) || fail build

echo "=== create 2 standalone roles ==="
DECLARED_ARN="$(aws iam create-role --role-name "$DECLARED_ROLE" --assume-role-policy-document "$ASSUME" \
  --query 'Role.Arn' --output text)" || fail "create declared role"
aws iam create-role --role-name "$UNION_ROLE" --assume-role-policy-document "$ASSUME" >/dev/null \
  || fail "create union role"
echo "declaredRole=$DECLARED_ROLE unionRole=$UNION_ROLE"
sleep 8 # role propagation before a policy can attach

echo "=== deploy (ManagedPolicy declares roles:[declaredRole]) ==="
npx cdk deploy -f "$STACK" -c "declaredRoleArn=$DECLARED_ARN" --require-approval never || fail deploy

MANAGED_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::ManagedPolicy'].PhysicalResourceId" --output text)"
[ -n "$MANAGED_ARN" ] || fail "could not resolve managed policy ARN"

echo "=== attach unionRole out of band (the live UNION member) ==="
aws iam attach-role-policy --role-name "$UNION_ROLE" --policy-arn "$MANAGED_ARN" || fail "attach union role"
sleep 10

echo "=== record (baseline) ==="
$CLI record "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --yes || fail record

echo "=== check CLEAN — the union member (unionRole) must NOT false-drift ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail | tee /tmp/cdkrd-mpd-clean.out
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record (union member false-positived?)"
grep -q "$UNION_ROLE" /tmp/cdkrd-mpd-clean.out && fail "union member was reported (asymmetric FP)"

echo "=== detach the DECLARED role out of band ==="
aws iam detach-role-policy --role-name "$DECLARED_ROLE" --policy-arn "$MANAGED_ARN" || fail "detach declared role"
echo "(waiting for IAM propagation)"; sleep 12

echo "=== check DETECTS the declared-role detach (exit 1) ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail | tee /tmp/cdkrd-mpd-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1 after detach"
grep -q "Roles" /tmp/cdkrd-mpd-pre.out || fail "Roles detach not reported"
grep -q "$DECLARED_ROLE" /tmp/cdkrd-mpd-pre.out || fail "detached declaredRole not named in the finding"
grep -q "$UNION_ROLE" /tmp/cdkrd-mpd-pre.out && fail "union member surfaced during drift (asymmetric FP)"

echo "=== revert --yes (AttachRolePolicy re-attaches the declared role ONLY) ==="
$CLI revert "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --yes || fail "revert returned non-zero"
echo "(waiting for IAM propagation)"; sleep 10

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" -c "declaredRoleArn=$DECLARED_ARN" --fail
[ $? -eq 0 ] || fail "drift remains after revert"

echo "=== belt-and-suspenders: declared role re-attached AND union role untouched ==="
AFTER="$(aws iam list-entities-for-policy --policy-arn "$MANAGED_ARN" --region "$REGION" \
  --query 'PolicyRoles[].RoleName' --output text)"
echo "post-revert attached roles: $AFTER"
echo "$AFTER" | tr '\t' '\n' | grep -qx "$DECLARED_ROLE" || fail "declared role not re-attached by revert"
echo "$AFTER" | tr '\t' '\n' | grep -qx "$UNION_ROLE" || fail "union role was lost (revert touched a non-declared member!)"

echo "INTEG PASS (CdkRealDriftIntegIamManagedPolicyDetach asymmetric detach detect+revert)"

#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Lambda aliases (the Lambda Function enumerator's
# THIRD child kind, after event source mappings and function URLs).
#   deploy fixture (Function + published version 1 + declared `live` alias) -> record ->
#      CLEAN (the declared `live` alias must NOT flag)
#   -> create-alias for an undeclared alias out of band -> check reports it under
#      [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots it (proves CC
#      GetResource + normalize for AWS::Lambda::Alias on the AliasArn) -> CLEAN
#   -> add ANOTHER out-of-band alias -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; deleting the function cascades its aliases (no orphan-block).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/lambda-alias-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLambdaAliasAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_alias() { # $1 = alias name -> creates an alias on the function pointing at version 1
  aws lambda create-alias --function-name "$FN_NAME" --name "$1" --function-version 1 \
    --region "$REGION" >/dev/null || fail "create-alias $1"
}

# A freshly-deployed function can briefly report Role Arn / RoleId under eventual
# consistency; re-record a few times until check is CLEAN before proceeding.
record_until_clean() {
  for _ in 1 2 3 4 5; do
    $CLI record "$STACK" --region "$REGION" --yes >/dev/null || fail "record"
    $CLI check "$STACK" --region "$REGION" --fail >/dev/null && return 0
    sleep 5
  done
  return 1
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) + check should be CLEAN (declared 'live' alias not flagged) ==="
record_until_clean || fail "expected CLEAN (exit 0) right after record"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve Function name"

echo "=== wire an undeclared alias out of band ==="
inject_alias cdkrd-integ-oob-record

echo "=== check reports the alias as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-alias.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-alias.out || fail "added alias not under [Potential Drift]"
grep -q "AWS::Lambda::Alias" /tmp/cdkrd-integ-alias.out || fail "the out-of-band alias not reported"
grep -q "added=" /tmp/cdkrd-integ-alias.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added alias (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the AliasArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-alias-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added alias, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-alias-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band alias for the revert path ==="
inject_alias cdkrd-integ-oob-revert

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-alias-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-alias-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-alias-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-alias-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second alias must be gone from AWS ==="
if aws lambda get-alias --function-name "$FN_NAME" --name cdkrd-integ-oob-revert --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted alias still exists (delete did not take effect)"
fi

echo "INTEG PASS"

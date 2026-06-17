#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Lambda versions (the Lambda Function enumerator's
# FOURTH child kind, after event source mappings, function URLs, and aliases).
#   deploy fixture (Function + published version 1) -> record ->
#      CLEAN (the declared version 1 AND the $LATEST pseudo-version must NOT flag)
#   -> publish-version an undeclared version out of band -> check reports it under
#      [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it (proves CC
#      GetResource + normalize for AWS::Lambda::Version on the versioned FunctionArn)
#      -> CLEAN
#   -> publish ANOTHER out-of-band version -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; deleting the function cascades its versions (no orphan-block).
#
# Publishing a version requires a change vs the last published one, so each oob step bumps
# the function description (update-function-configuration), publish-version (which snapshots
# that changed config into the NEW version), then RESETS the live function's description to
# its original value — so the version is added but the Function resource itself shows no
# lingering undeclared `Description` drift.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/lambda-version-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLambdaVersionAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

wait_updated() { # block until the function's last update has settled (publish requires it)
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1 || true
}

inject_version() { # $1 = a description to force a change -> publishes a NEW version, echoes its number
  aws lambda update-function-configuration --function-name "$FN_NAME" --description "$1" \
    --region "$REGION" >/dev/null || fail "update-function-configuration $1"
  wait_updated
  local v
  v="$(aws lambda publish-version --function-name "$FN_NAME" --region "$REGION" \
    --query Version --output text)" || fail "publish-version $1"
  # Reset the live function's description back to its original (empty) value so the Function
  # resource itself shows no lingering undeclared Description drift — only the new version
  # is the out-of-band `added` finding under test.
  aws lambda update-function-configuration --function-name "$FN_NAME" --description "" \
    --region "$REGION" >/dev/null || fail "reset description"
  wait_updated
  echo "$v"
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

echo "=== record (write baseline) + check should be CLEAN (declared version 1 + \$LATEST not flagged) ==="
record_until_clean || fail "expected CLEAN (exit 0) right after record"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve Function name"

echo "=== publish an undeclared version out of band ==="
V_RECORD="$(inject_version cdkrd-integ-oob-record)"
echo "published out-of-band version: $V_RECORD"

echo "=== check reports the version as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-version.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-version.out || fail "added version not under [Not Recorded]"
grep -q "AWS::Lambda::Version" /tmp/cdkrd-integ-version.out || fail "the out-of-band version not reported"
grep -q "added=" /tmp/cdkrd-integ-version.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added version (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the versioned FunctionArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-version-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added version, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-version-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== publish ANOTHER out-of-band version for the revert path ==="
V_REVERT="$(inject_version cdkrd-integ-oob-revert)"
echo "published revert-target version: $V_REVERT"

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-version-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-version-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-version-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-version-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second version must be gone from AWS ==="
if aws lambda get-function --function-name "$FN_NAME:$V_REVERT" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted version still exists (delete did not take effect)"
fi

echo "INTEG PASS"

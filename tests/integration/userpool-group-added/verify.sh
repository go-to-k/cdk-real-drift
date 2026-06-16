#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Cognito user pool GROUPS (a SECOND child type
# under the AWS::Cognito::UserPool parent — alongside clients).
#   deploy fixture (UserPool + one declared UserPoolGroup) -> record -> CLEAN
#   -> create-group an undeclared group on the SAME pool out of band -> check reports the
#      group under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it (proves
#      CC GetResource + normalize for AWS::Cognito::UserPoolGroup on the composite
#      UserPoolId|GroupName) -> CLEAN
#   -> add ANOTHER out-of-band group -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource (composite UserPoolId|GroupName) -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the UserPool CASCADES its groups (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/userpool-group-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegUserPoolGroupAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting a UserPool CASCADES its groups, so an out-of-band group we recorded (but did
  # not revert) does NOT block the pool's deletion — delstack tears the pool (and its
  # groups) down with the stack. No stack-external orphan sweep is needed.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_group() { # $1 = group name -> creates a group on the pool (idempotent per name)
  aws cognito-idp create-group --user-pool-id "$POOL" --group-name "$1" \
    --region "$REGION" >/dev/null || fail "create-group $1"
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

POOL="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId" --output text)"
[ -n "$POOL" ] || fail "could not resolve UserPool id"

echo "=== create an undeclared group on the pool out of band ==="
inject_group cdkrd-integ-oob-record

echo "=== check reports the group as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upg.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-upg.out || fail "added group not under [Not Recorded]"
grep -q "AWS::Cognito::UserPoolGroup" /tmp/cdkrd-integ-upg.out || fail "the out-of-band group not reported"
grep -q "added=" /tmp/cdkrd-integ-upg.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added group (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite UserPoolId|GroupName) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upg-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added group, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-upg-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band group for the revert path ==="
inject_group cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upg-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-upg-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-upg-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-upg-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second group must be gone from AWS ==="
if aws cognito-idp get-group --user-pool-id "$POOL" --group-name cdkrd-integ-oob-revert --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted group still exists (delete did not take effect)"
fi

echo "INTEG PASS"

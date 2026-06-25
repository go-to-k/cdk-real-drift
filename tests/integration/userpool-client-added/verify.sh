#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Cognito (the SIXTH CHILD_ENUMERATORS member).
#   deploy fixture (UserPool + one declared UserPoolClient) -> record -> CLEAN
#   -> create-user-pool-client an undeclared client on the SAME pool out of band -> check
#      reports the client under [Potential Drift] and is NOT drift (exit 0) -> `record`
#      snapshots it (proves CC GetResource + normalize for AWS::Cognito::UserPoolClient)
#      -> CLEAN
#   -> add ANOTHER out-of-band client -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource (composite UserPoolId|ClientId) -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the UserPool CASCADES its clients (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/userpool-client-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegUserPoolClientAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting a UserPool CASCADES its clients, so an out-of-band client we recorded (but did
  # not revert) does NOT block the pool's deletion — delstack tears the pool (and its
  # clients) down with the stack. No stack-external orphan sweep is needed.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_client() { # $1 = client name -> creates an app client on the pool, echoes its ClientId
  aws cognito-idp create-user-pool-client --user-pool-id "$POOL" --client-name "$1" \
    --region "$REGION" --query "UserPoolClient.ClientId" --output text || fail "create-user-pool-client $1"
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

echo "=== create an undeclared client on the pool out of band ==="
inject_client cdkrd-integ-oob-record >/dev/null

echo "=== check reports the client as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upc.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-upc.out || fail "added client not under [Potential Drift]"
grep -q "AWS::Cognito::UserPoolClient" /tmp/cdkrd-integ-upc.out || fail "the out-of-band client not reported"
grep -q "added=" /tmp/cdkrd-integ-upc.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added client (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for UserPoolClient) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upc-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added client, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-upc-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band client for the revert path ==="
REVERT_CLIENT_ID="$(inject_client cdkrd-integ-oob-revert)"
[ -n "$REVERT_CLIENT_ID" ] || fail "could not capture the revert client's ClientId"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-upc-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-upc-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-upc-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-upc-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second client must be gone from AWS ==="
if aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$REVERT_CLIENT_ID" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted client still exists (delete did not take effect)"
fi

echo "INTEG PASS"

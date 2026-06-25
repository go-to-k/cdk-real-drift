#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Cognito user pool RESOURCE SERVERS (a THIRD child
# type under the AWS::Cognito::UserPool parent — alongside clients and groups).
#   deploy fixture (UserPool + one declared UserPoolResourceServer) -> record -> CLEAN
#   -> create-resource-server an undeclared resource server on the SAME pool out of band ->
#      check reports it under [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots
#      it (proves CC GetResource + normalize for AWS::Cognito::UserPoolResourceServer on the
#      composite UserPoolId|Identifier) -> CLEAN
#   -> add ANOTHER out-of-band resource server -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource (composite UserPoolId|Identifier) -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the UserPool CASCADES its resource servers (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/userpool-resourceserver-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegUserPoolResourceServerAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting a UserPool CASCADES its resource servers, so an out-of-band resource server we
  # recorded (but did not revert) does NOT block the pool's deletion — delstack tears the
  # pool (and its resource servers) down with the stack. No stack-external orphan sweep needed.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_rs() { # $1 = identifier, $2 = name -> creates a resource server on the pool
  aws cognito-idp create-resource-server --user-pool-id "$POOL" --identifier "$1" --name "$2" \
    --region "$REGION" >/dev/null || fail "create-resource-server $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared resource server NOT flagged) ==="
# A freshly-created UserPool populates its GetAtt attributes (Arn/ProviderName/ProviderURL)
# with slight eventual-consistency lag, which can flap the baseline captured by the first
# record. Re-record + re-check a few times to let the pool settle (not a resource-server
# concern — the declared resource server itself is stable on creation).
clean=0
for _ in 1 2 3 4 5; do
  if $CLI check "$STACK" --region "$REGION" --fail; then clean=1; break; fi
  echo "    (pool attributes still settling — re-record and retry)"
  sleep 10
  $CLI record "$STACK" --region "$REGION" --yes || fail "record (settle)"
done
[ "$clean" -eq 1 ] || fail "expected CLEAN (exit 0) right after record"

POOL="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId" --output text)"
[ -n "$POOL" ] || fail "could not resolve UserPool id"

echo "=== create an undeclared resource server on the pool out of band ==="
inject_rs https://oob-record.cdkrd.example oob-record

echo "=== check reports the resource server as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-uprs.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-uprs.out || fail "added resource server not under [Potential Drift]"
grep -q "AWS::Cognito::UserPoolResourceServer" /tmp/cdkrd-integ-uprs.out || fail "the out-of-band resource server not reported"
grep -q "added=" /tmp/cdkrd-integ-uprs.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added resource server (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite UserPoolId|Identifier) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-uprs-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added resource server, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-uprs-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band resource server for the revert path ==="
inject_rs https://oob-revert.cdkrd.example oob-revert

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-uprs-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-uprs-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-uprs-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-uprs-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second resource server must be gone from AWS ==="
if aws cognito-idp describe-resource-server --user-pool-id "$POOL" --identifier https://oob-revert.cdkrd.example --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted resource server still exists (delete did not take effect)"
fi

echo "INTEG PASS"

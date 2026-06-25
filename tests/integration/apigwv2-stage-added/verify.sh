#!/usr/bin/env bash
# cdk-real-drift `added` integ test for API Gateway V2 (HTTP API) Stages —
# extending the SECOND CHILD_ENUMERATORS member (AWS::ApiGatewayV2::Api) to also
# enumerate AWS::ApiGatewayV2::Stage. Proves the whole arc on the new child type:
#   deploy fixture (HTTP API, declared `prod` stage) -> record -> check CLEAN
#      (the DECLARED `prod` stage must NOT be flagged; an HTTP API may auto-create a
#      `$default` stage only if configured — if one shows up it is recorded too, so
#      CLEAN holds either way)
#   -> create a Stage out of band (aws apigatewayv2) -> check reports it under
#      [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots it (proves CC
#      GetResource on the composite ApiId|StageName + normalize work) -> check CLEAN
#   -> create ANOTHER out-of-band Stage -> `revert --remove-unrecorded` DELETES it
#      via Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss all of this (template-only). A cleanup trap
# destroys the stack even on failure, so no orphan resources remain (deleting the Api
# cascades its stages).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/apigwv2-stage-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegApiGwV2StageAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_stage() { # $1 = stage name
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name "$1" \
    --region "$REGION" >/dev/null || fail "create-stage $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (the DECLARED prod stage must NOT be flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2stage-init.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-v2stage-init.out && fail "declared stage must not be flagged" || true

API_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)"
[ -n "$API_ID" ] || fail "could not resolve HTTP Api id"

echo "=== inject an out-of-band Stage (cdkrdoob) ==="
inject_stage 'cdkrdoob'

echo "=== check reports it as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2stage.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-v2stage.out || fail "added stage not under [Potential Drift]"
grep -q "AWS::ApiGatewayV2::Stage" /tmp/cdkrd-integ-v2stage.out || fail "AWS::ApiGatewayV2::Stage not reported"
grep -q "added=" /tmp/cdkrd-integ-v2stage.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added stage (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite id) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2stage-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added stage, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-v2stage-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== inject ANOTHER out-of-band Stage (cdkrdoobrevert) for the revert path ==="
inject_stage 'cdkrdoobrevert'

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2stage-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"
grep -q "cdkrdoobrevert" /tmp/cdkrd-integ-v2stage-rev.out || fail "the second out-of-band stage not reported"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-v2stage-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-v2stage-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-v2stage-revert.out || fail "revert did not converge to CLEAN"

echo "=== the cdkrdoobrevert stage must be gone from AWS ==="
if [ "$(aws apigatewayv2 get-stages --api-id "$API_ID" --region "$REGION" \
  --query "Items[?StageName=='cdkrdoobrevert']" --output json)" != "[]" ]; then
  fail "cdkrdoobrevert still exists after revert (delete did not take effect)"
fi

echo "INTEG PASS"

#!/usr/bin/env bash
# cdk-real-drift `added` integ test for API Gateway REST API MODELS + REQUEST VALIDATORS
# (an extension of the RestApi CHILD_ENUMERATORS member, which already covers Resources
# + Methods + Authorizers).
#   deploy fixture (RestApi + one method + one DECLARED Model + one DECLARED RequestValidator)
#   -> record -> CLEAN (the DECLARED Model + Validator AND the built-in Empty/Error models
#      are NOT flagged — `record` snapshots the built-ins so they never false-positive)
#   -> create-model + create-request-validator (undeclared) on the SAME api out of band ->
#      check reports BOTH under [Potential Drift] with AWS::ApiGateway::Model and
#      AWS::ApiGateway::RequestValidator, NOT drift (exit 0)
#   -> `record` snapshots them (proves CC GetResource on the composites
#      RestApiId|Name + RestApiId|RequestValidatorId) -> CLEAN
#   -> add ANOTHER out-of-band model + validator -> `revert --remove-unrecorded` DELETES
#      them via Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; deleting the RestApi cascades its models/validators (no orphan).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/restapi-model-validator-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegRestApiModelValidatorAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_model() { # $1 = model name -> creates a model on the api
  aws apigateway create-model --rest-api-id "$API" --name "$1" \
    --content-type application/json --schema '{}' \
    --region "$REGION" >/dev/null || fail "create-model $1"
}

inject_validator() { # $1 = validator name -> creates a request validator on the api
  aws apigateway create-request-validator --rest-api-id "$API" --name "$1" \
    --validate-request-body \
    --region "$REGION" >/dev/null || fail "create-request-validator $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

API="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId" --output text)"
[ -n "$API" ] || fail "could not resolve RestApi id"

echo "=== record (write baseline; snapshots the built-in Empty/Error models) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared Model + Validator + built-in Empty/Error NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-mv-clean0.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record"
grep -q "AWS::ApiGateway::Model" /tmp/cdkrd-integ-mv-clean0.out && fail "a model was falsely flagged after record" || true
grep -q "AWS::ApiGateway::RequestValidator" /tmp/cdkrd-integ-mv-clean0.out && fail "the declared validator was falsely flagged" || true

echo "=== create an undeclared model + validator on the api out of band ==="
inject_model cdkrdOobModel
inject_validator cdkrd-oob-validator

echo "=== check reports BOTH as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-mv.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-mv.out || fail "added model/validator not under [Potential Drift]"
grep -q "AWS::ApiGateway::Model" /tmp/cdkrd-integ-mv.out || fail "the out-of-band model not reported"
grep -q "AWS::ApiGateway::RequestValidator" /tmp/cdkrd-integ-mv.out || fail "the out-of-band validator not reported"
grep -q "added=" /tmp/cdkrd-integ-mv.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added model + validator (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on both composite ids + normalize) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-mv-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added model+validator, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-mv-clean.out && fail "still Not-Recorded after record (GetResource on a composite id likely failed)" || true

echo "=== add ANOTHER out-of-band model + validator for the revert path ==="
inject_model cdkrdOobModelRev
inject_validator cdkrd-oob-validator-rev

echo "=== check reports the new ones under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-mv-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second batch of unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES them (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-mv-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-mv-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-mv-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second model must be gone from AWS ==="
leftm="$(aws apigateway get-models --rest-api-id "$API" --region "$REGION" \
  --query "items[?name=='cdkrdOobModelRev']" --output json)"
[ "$(echo "$leftm" | tr -d '[:space:]')" = "[]" ] || fail "the reverted model still exists (delete did not take effect)"

echo "=== the second validator must be gone from AWS ==="
leftv="$(aws apigateway get-request-validators --rest-api-id "$API" --region "$REGION" \
  --query "items[?name=='cdkrd-oob-validator-rev']" --output json)"
[ "$(echo "$leftv" | tr -d '[:space:]')" = "[]" ] || fail "the reverted validator still exists (delete did not take effect)"

echo "INTEG PASS"

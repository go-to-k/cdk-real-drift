#!/usr/bin/env bash
# cdk-real-drift `added` integ test for API Gateway REST API AUTHORIZERS (an extension
# of the RestApi CHILD_ENUMERATORS member, which already covers Resources + Methods).
#   deploy fixture (RestApi + one method + Lambda + one DECLARED TOKEN authorizer)
#   -> record -> CLEAN (the DECLARED authorizer is NOT flagged)
#   -> create-authorizer an undeclared authorizer on the SAME api out of band -> check
#      reports it under [Not Recorded] with AWS::ApiGateway::Authorizer, NOT drift (exit 0)
#   -> `record` snapshots it (proves CC GetResource on the composite RestApiId|AuthorizerId
#      + normalize for AWS::ApiGateway::Authorizer) -> CLEAN
#   -> add ANOTHER out-of-band authorizer -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; deleting the RestApi cascades its authorizers (no orphan).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/restapi-authorizer-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegRestApiAuthorizerAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_authorizer() { # $1 = authorizer name -> creates a TOKEN authorizer on the api
  aws apigateway create-authorizer --rest-api-id "$API" --name "$1" --type TOKEN \
    --authorizer-uri "$URI" --identity-source 'method.request.header.Auth' \
    --region "$REGION" >/dev/null || fail "create-authorizer $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (the DECLARED authorizer must NOT be flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-auth-clean0.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record"
grep -q "AWS::ApiGateway::Authorizer" /tmp/cdkrd-integ-auth-clean0.out && fail "declared authorizer was falsely flagged" || true

API="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId" --output text)"
[ -n "$API" ] || fail "could not resolve RestApi id"

FN_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
FN_ARN="$(aws lambda get-function --function-name "$FN_ARN" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)"
[ -n "$FN_ARN" ] || fail "could not resolve AuthFn arn"
URI="arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$FN_ARN/invocations"

echo "=== create an undeclared authorizer on the api out of band ==="
inject_authorizer cdkrd-integ-oob-record

echo "=== check reports the authorizer as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-auth.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-auth.out || fail "added authorizer not under [Not Recorded]"
grep -q "AWS::ApiGateway::Authorizer" /tmp/cdkrd-integ-auth.out || fail "the out-of-band authorizer not reported"
grep -q "added=" /tmp/cdkrd-integ-auth.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added authorizer (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite id + normalize) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-auth-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added authorizer, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-auth-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band authorizer for the revert path ==="
inject_authorizer cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-auth-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-auth-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-auth-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-auth-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second authorizer must be gone from AWS ==="
left="$(aws apigateway get-authorizers --rest-api-id "$API" --region "$REGION" \
  --query "items[?name=='cdkrd-integ-oob-revert']" --output json)"
[ "$(echo "$left" | tr -d '[:space:]')" = "[]" ] || fail "the reverted authorizer still exists (delete did not take effect)"

echo "INTEG PASS"

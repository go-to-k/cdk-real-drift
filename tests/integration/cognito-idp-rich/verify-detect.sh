#!/usr/bin/env bash
# Cognito UserPoolIdentityProvider detect + revert integration test (real AWS): the
# "someone changed it in the console" scenario, which also exercises the composite
# UserPoolId|ProviderName CC identifier read path end to end. Deploy -> record ->
# change AttributeMapping out of band (a declared, MUTABLE free-form map) -> check
# MUST DETECT the declared drift (exit 1) -> revert -> check MUST be CLEAN and the
# live AttributeMapping MUST be restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCognitoIdpRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

POOL="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId" --output text)"
[ -n "$POOL" ] || fail "could not resolve user pool id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change the IdP AttributeMapping (console-edit) ==="
aws cognito-idp update-identity-provider --user-pool-id "$POOL" --provider-name Google \
  --region "$REGION" --attribute-mapping email=given_name >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-idp-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "AttributeMapping" /tmp/cdkrd-idp-detect.out || fail "AttributeMapping drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live AttributeMapping MUST be restored ==="
GOT="$(aws cognito-idp describe-identity-provider --user-pool-id "$POOL" --provider-name Google \
  --region "$REGION" --query "IdentityProvider.AttributeMapping.email" --output text)"
[ "$GOT" = "email" ] || fail "live AttributeMapping not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

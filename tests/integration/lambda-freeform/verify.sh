#!/usr/bin/env bash
# cdk-real-drift Lambda free-form-map + Alias-revert integration test (real AWS).
#
# Covers three reported bugs, all on a Lambda + its Alias:
#   (1) an UNDECLARED env var added to a free-form Environment.Variables map is SURFACED
#       (a free-form map key, not folded into the undeclared-subkey count);
#   (2) reverting an UNDECLARED Alias Description CLEARS it — UpdateAlias ignores an
#       omitted description (a bare `remove` is a silent no-op), so revert must write the
#       empty-string default;
#   (3) reverting the UNDECLARED env var REMOVES it — a pure-dotted nested path is a valid
#       RFC6902 pointer Cloud Control applies.
#
# Flow:
#   deploy
#   PHASE 1 (problem 1): inject undeclared env var (NO baseline) -> check SURFACES the
#     Environment.Variables.<key> path (proof it is not folded into undeclared-subkey)
#   reset env -> record a CLEAN baseline
#   PHASE 2 (problems 2+3): inject undeclared env var + Alias Description -> check DETECTS
#     both as drift -> revert -> re-read live: env var GONE, Description "" -> declared var survives
# A cleanup trap force-deletes the stack (delstack) and removes the baseline even on
# failure, so a failed run leaves no orphans.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/lambda-freeform && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLambdaFreeform
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
DECLARED_ENV='USER_POOL_ID_PARAMETER_STORE_NAME=/auth/goto/user-pool-id'

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"

set_env() { # $1 = full Variables={...} spec
  aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
    --environment "$1" >/dev/null || fail "update env"
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true
}

echo "=== PHASE 1: inject undeclared env var, NO baseline (problem 1: surfaced, not folded) ==="
set_env "Variables={${DECLARED_ENV},testtesttess=testtesttess}"
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-integ-lff-p1.out
grep -q "Environment.Variables.testtesttess" /tmp/cdkrd-integ-lff-p1.out \
  || fail "problem 1: undeclared env var not surfaced (still folded into undeclared-subkey?)"

echo "=== reset env to clean, record CLEAN baseline ==="
set_env "Variables={${DECLARED_ENV}}"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== PHASE 2: inject undeclared env var + Alias Description out of band ==="
set_env "Variables={${DECLARED_ENV},testtesttess=testtesttess}"
aws lambda update-alias --function-name "$FN_NAME" --name live --description "test" --region "$REGION" >/dev/null \
  || fail "inject alias description"

echo "=== check should DETECT both as drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-lff-p2.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Environment.Variables.testtesttess" /tmp/cdkrd-integ-lff-p2.out || fail "env var drift not reported"
grep -qi "Description" /tmp/cdkrd-integ-lff-p2.out || fail "alias Description drift not reported"

echo "=== revert (clears the out-of-band values; only these are drift vs baseline) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-integ-lff-revert.out \
  || fail "revert command errored"

echo "=== verify convergence on the live resources ==="
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true
ENV_AFTER="$(aws lambda get-function-configuration --function-name "$FN_NAME" --region "$REGION" \
  --query 'Environment.Variables' --output json | tr -d ' \n')"
echo "env after revert: $ENV_AFTER"
echo "$ENV_AFTER" | grep -q "testtesttess" && fail "problem 3: undeclared env var NOT removed by revert"

DESC_AFTER="$(aws lambda get-alias --function-name "$FN_NAME" --name live --region "$REGION" \
  --query 'Description' --output text)"
echo "alias description after revert: '$DESC_AFTER'"
[ "$DESC_AFTER" = "None" ] || [ -z "$DESC_AFTER" ] || fail "problem 2: alias Description NOT cleared (still '$DESC_AFTER')"

echo "$ENV_AFTER" | grep -q "USER_POOL_ID_PARAMETER_STORE_NAME" \
  || fail "declared env var was wrongly removed"

echo "INTEG PASS"

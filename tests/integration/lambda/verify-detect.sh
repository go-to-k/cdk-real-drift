#!/usr/bin/env bash
# Lambda Function detect + revert (real AWS): flip the declared MUTABLE Description out
# of band (update-function-configuration) -> check MUST DETECT -> revert (CC) -> CLEAN
# + restored. (Lambda is the most common compute resource; revert via Cloud Control.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegLambda; DESIRED="cdk-real-drift Lambda integration test function"; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text | head -1)"
[ -n "$FN" ] && [ "$FN" != "None" ] || fail "no function name"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob Description -> DRIFTED ==="
aws lambda update-function-configuration --function-name "$FN" --description "DRIFTED DESC" --region "$REGION" >/dev/null || fail inject
sleep 4
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-lambda-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Description" /tmp/cdkrd-lambda-detect.out || fail "Description drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
sleep 4
GOT="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" --query Description --output text)"
[ "$GOT" = "$DESIRED" ] || fail "Description not restored (got: $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

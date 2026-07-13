#!/usr/bin/env bash
# #1585 revert-convergence regression (real AWS): ApiGatewayV2 Api
# DisableExecuteApiEndpoint + Route AuthorizationType both no-op on a bare `remove`
# revert (UpdateApi / UpdateRoute ignore the omitted property), so revert must write
# their KNOWN_DEFAULTS defaults (false / "NONE") explicitly.
#
# EventSourceMapping Enabled is mutated too, as a CONTROL that it converges via the
# bare `remove` (UpdateEventSourceMapping re-enables on omit) — it is intentionally
# NOT in REVERT_SET_DEFAULT_PATHS (the non-uniformity guard).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevertNoop2x0714
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

ESM="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Esm \
  --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
API="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id HttpApi \
  --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
ROUTE="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Route \
  --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
[ -n "$API" ] && [ -n "$ROUTE" ] && [ -n "$ESM" ] || fail "could not resolve physical ids"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== wait ESM Enabled, then out-of-band mutations ==="
for i in $(seq 1 15); do st=$(aws lambda get-event-source-mapping --uuid "$ESM" --region "$REGION" --query 'State' --output text 2>/dev/null); [ "$st" = "Enabled" ] && break; sleep 5; done
aws lambda update-event-source-mapping --uuid "$ESM" --region "$REGION" --no-enabled >/dev/null || fail "esm mutate"
aws apigatewayv2 update-api --api-id "$API" --region "$REGION" --disable-execute-api-endpoint >/dev/null || fail "api mutate"
aws apigatewayv2 update-route --api-id "$API" --route-id "$ROUTE" --region "$REGION" --authorization-type AWS_IAM >/dev/null || fail "route mutate"
for i in $(seq 1 15); do st=$(aws lambda get-event-source-mapping --uuid "$ESM" --region "$REGION" --query 'State' --output text 2>/dev/null); [ "$st" = "Disabled" ] && break; sleep 5; done

echo "=== check MUST DETECT (>=3 undeclared drifts) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-noop2-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "DisableExecuteApiEndpoint" /tmp/cdkrd-noop2-detect.out || fail "DisableExecuteApiEndpoint not reported"
grep -q "AuthorizationType" /tmp/cdkrd-noop2-detect.out || fail "AuthorizationType not reported"

echo "=== revert (set-default for the two no-op targets, remove for the ESM control) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert (convergence) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert — a revert did not converge"

echo "=== live values MUST be restored to defaults ==="
DE="$(aws apigatewayv2 get-api --api-id "$API" --region "$REGION" --query 'DisableExecuteApiEndpoint' --output text)"
AT="$(aws apigatewayv2 get-route --api-id "$API" --route-id "$ROUTE" --region "$REGION" --query 'AuthorizationType' --output text)"
[ "$DE" = "False" ] || fail "DisableExecuteApiEndpoint not restored (got: $DE)"
[ "$AT" = "NONE" ] || fail "AuthorizationType not restored (got: $AT)"

echo "INTEG PASS ($STACK detect+revert, #1585)"

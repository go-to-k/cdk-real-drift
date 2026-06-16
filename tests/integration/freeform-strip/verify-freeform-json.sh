#!/usr/bin/env bash
# cdk-real-drift free-form-map JSON-VALUE canonicalization false-negative test (real AWS).
#
# Proves WAVE21: the policy/json-text canonicalizers re-serialized (sorted) a JSON-shaped
# value inside a free-form USER map (Lambda Environment.Variables), so a real out-of-band
# key-ORDER edit of the user's JSON config string was folded away — silently CLEAN (a
# false negative). AWS stores Lambda env var values VERBATIM (Map<String,String>), so the
# canonicalization was never compensating for an AWS reshape; it only HID user edits.
#
#   deploy (CONFIG='{"region":"us-east-1","mode":"a"}') -> check CLEAN (FP-safety: the
#     present value is read back verbatim, declared == live)
#   -> reorder CONFIG's keys out of band (same data, different order)
#   -> check DETECTS the Environment.Variables.CONFIG drift (before the fix: CLEAN)
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegFreeform
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy (Lambda with a JSON-shaped CONFIG env var) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function name"
echo "function=$FN_NAME"

echo "=== check should be CLEAN (the JSON value is read back verbatim -> no FP) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN — a verbatim JSON env value was misread as drift (FP)"

echo "=== reorder CONFIG's keys out of band (same data, different key order) ==="
# Pass the env as a JSON file — the shorthand parser chokes on a JSON-string value.
ENV_JSON="$(mktemp)"
printf '{"Variables":{"APP_VERSION":"x","CONFIG":"{\\"mode\\":\\"a\\",\\"region\\":\\"us-east-1\\"}"}}' > "$ENV_JSON"
aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
  --environment "file://$ENV_JSON" >/dev/null || fail "update-function-configuration"
rm -f "$ENV_JSON"
# wait for the config update to settle
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true

echo "=== check MUST detect the CONFIG key-order edit (declared drift) ==="
OUT=/tmp/cdkrd-freeform-json.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for the CONFIG key-order edit, got $rc (folded away?)"
grep -qi "CONFIG" "$OUT" || fail "the CONFIG env-var edit was not reported"

echo "INTEG PASS"

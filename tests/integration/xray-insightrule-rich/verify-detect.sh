#!/usr/bin/env bash
# Missed-detection (FN) integration test (real AWS): deploy -> record -> mutate a
# declared MUTABLE prop out of band (X-Ray SamplingRule FixedRate, the "someone
# changed it in the console" scenario) -> check MUST detect (exit 1) -> revert ->
# check MUST be CLEAN and the live value restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegXrayInsightRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate SamplingRule FixedRate out of band (0.05 -> 0.5) ==="
aws xray update-sampling-rule --region "$REGION" --cli-input-json '{
  "SamplingRuleUpdate": { "RuleName": "cdkrd-hunt-sampling", "FixedRate": 0.5 }
}' >/dev/null || fail "out-of-band mutation"

echo "=== [$STACK] check MUST detect the drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || { echo "--- MISSED DETECTION: FixedRate mutation not reported ---"; fail "expected drift (exit 1), got $rc"; }
grep -q "FixedRate" "/tmp/cdkrd-$STACK-detect.out" || fail "drift reported but not on FixedRate"

echo "=== [$STACK] revert MUST restore the declared value ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

LIVE_RATE=$(aws xray get-sampling-rules --region "$REGION" \
  --query 'SamplingRuleRecords[?SamplingRule.RuleName==`cdkrd-hunt-sampling`].SamplingRule.FixedRate' --output text)
[ "$LIVE_RATE" = "0.05" ] || fail "live FixedRate is $LIVE_RATE, expected 0.05 after revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK detect/revert)"

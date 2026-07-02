#!/usr/bin/env bash
# Read-gap + missed-detection integration test (real AWS) for
# AWS::CloudWatch::AnomalyDetector (issue #461 — NON_PROVISIONABLE, read via the
# DescribeAnomalyDetectors SDK override):
#   1. deploy -> the detector must be READ (skipped=0), record -> check CLEAN.
#   2. flip Configuration.MetricTimezone out of band (put-anomaly-detector) ->
#      check MUST detect the declared drift (exit 1) -> revert (PutAnomalyDetector
#      writer) -> check CLEAN and the live timezone is restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCwAnomaly
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
DETECTOR='{"Namespace":"AWS/Lambda","MetricName":"Errors","Stat":"Sum","Dimensions":[{"Name":"FunctionName","Value":"cdkrd-integ-anomaly-fn"}]}'

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] harvest corpus (pre-record fresh check) ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-/tmp/corpus-cw-anomaly}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK-fresh.out"
grep -q "skipped=" "/tmp/cdkrd-$STACK-fresh.out" && fail "detector still skipped — the SDK override reader did not engage"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] FN half: flip MetricTimezone out of band ==="
aws cloudwatch put-anomaly-detector --region "$REGION" \
  --single-metric-anomaly-detector "$DETECTOR" \
  --configuration '{"MetricTimezone":"UTC"}' || fail "put-anomaly-detector"

echo "=== [$STACK] check MUST DETECT the Configuration drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || { echo "--- MISSED DETECTION: out-of-band timezone flip not reported ---"; fail "expected drift (exit 1), got $rc"; }
grep -q "MetricTimeZone" "/tmp/cdkrd-$STACK-detect.out" || fail "drift report does not mention MetricTimeZone"

echo "=== [$STACK] revert the drift ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "=== [$STACK] live timezone MUST be restored ==="
tz="$(aws cloudwatch describe-anomaly-detectors --region "$REGION" \
  --namespace AWS/Lambda --metric-name Errors \
  --query 'AnomalyDetectors[0].Configuration.MetricTimezone' --output text)"
[ "$tz" = "Asia/Tokyo" ] || fail "live timezone not restored (got $tz)"

echo "INTEG PASS ($STACK)"

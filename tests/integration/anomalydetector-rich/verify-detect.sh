#!/usr/bin/env bash
# Detect + revert integration test (real AWS): flip the single-metric detector's
# Configuration out of band (MetricTimezone UTC -> America/New_York, the "someone
# edited the anomaly model in the console" scenario). check MUST DETECT the declared
# drift (exit 1) -> revert (PutAnomalyDetector) -> check MUST be CLEAN and the live
# timezone restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAnomalyDetector
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
SMAD='{"Namespace":"AWS/Lambda","MetricName":"Errors","Dimensions":[{"Name":"FunctionName","Value":"cdkrd-hunt-anomaly-fn"}],"Stat":"Sum"}'

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Configuration MetricTimezone UTC -> America/New_York ==="
aws cloudwatch put-anomaly-detector --region "$REGION" \
  --single-metric-anomaly-detector "$SMAD" \
  --configuration '{"MetricTimezone":"America/New_York","ExcludedTimeRanges":[{"StartTime":"2026-12-24T00:00:00","EndTime":"2026-12-26T00:00:00"}]}' \
  || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "MetricTimeZone" "/tmp/cdkrd-$STACK-detect.out" || fail "MetricTimeZone drift not reported"

echo "=== revert (PutAnomalyDetector writes declared config back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE="$(aws cloudwatch describe-anomaly-detectors --region "$REGION" \
  --namespace AWS/Lambda --metric-name Errors \
  --query 'AnomalyDetectors[0].Configuration.MetricTimezone' --output text)"
[ "$LIVE" = "UTC" ] || fail "live MetricTimezone not restored (got $LIVE)"

echo "INTEG PASS ($STACK detect+revert)"

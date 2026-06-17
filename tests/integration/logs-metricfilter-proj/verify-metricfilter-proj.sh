#!/usr/bin/env bash
# cdk-real-drift AWS::Logs::MetricFilter projection FALSE-NEGATIVE integration test.
#
# The MetricFilter SDK-override reader projected FilterPattern + MetricTransformations but
# OMITTED ApplyOnTransformedLogs — so an out-of-band toggle (which changes whether the filter
# evaluates transformed vs original log events) was undetectable. The fix projects it. This
# deploys a filter that does NOT declare ApplyOnTransformedLogs, asserts CLEAN after record
# (FP guard: a never-set filter's false folds via isTrivialEmpty), then flips it true out of
# band and asserts cdkrd DETECTS it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMetricFilter
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

echo "=== deploy LogGroup + MetricFilter (no ApplyOnTransformedLogs) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

LG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)"
MF="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Logs::MetricFilter'].PhysicalResourceId" --output text)"
[ -n "$LG" ] && [ -n "$MF" ] || fail "could not resolve log group / filter name"
echo "log-group=$LG filter=$MF"

echo "=== record + check should be CLEAN (FP guard: ApplyOnTransformedLogs=false folds) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after record — ApplyOnTransformedLogs leaked as drift?"

echo "=== flip ApplyOnTransformedLogs true out of band — must DETECT it ==="
# Re-put the SAME filter (same pattern + transformations) with applyOnTransformedLogs=true.
aws logs put-metric-filter --region "$REGION" \
  --log-group-name "$LG" --filter-name "$MF" --filter-pattern "ERROR" \
  --apply-on-transformed-logs \
  --metric-transformations metricName=Errors,metricNamespace=CdkrdInteg,metricValue=1 \
  || fail "put-metric-filter"
OUT=/tmp/cdkrd-metricfilter-check.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for out-of-band ApplyOnTransformedLogs, got $rc"
grep -qi "ApplyOnTransformedLogs" "$OUT" || fail "out-of-band ApplyOnTransformedLogs not reported — still projected away?"

echo "INTEG PASS"

#!/usr/bin/env bash
# Logs MetricFilter detect->revert->clean (real AWS, mutating). Proves the new
# writeMetricFilter (PutMetricFilter) reverts an out-of-band FilterPattern edit.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegMetricFilterRevert; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
LG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)"
FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Logs::MetricFilter'].PhysicalResourceId" --output text)"
[ -n "$LG" ] && [ -n "$FN" ] || fail "could not resolve LogGroup/MetricFilter"
echo "logGroup=$LG filter=$FN"
echo "=== record + check CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"
echo "=== mutate FilterPattern out of band ('\"ERROR\"' -> '\"CHANGED\"') ==="
aws logs put-metric-filter --log-group-name "$LG" --filter-name "$FN" --filter-pattern '"CHANGED"' \
  --metric-transformations metricName=ErrorCount,metricNamespace=CdkrdRevertTest,metricValue=1,defaultValue=0 \
  --region "$REGION" || fail "out-of-band put-metric-filter"
sleep 3
echo "=== check DETECTS (exit 1, FilterPattern) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/mf-pre.out; [ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "FilterPattern" /tmp/mf-pre.out || fail "FilterPattern drift not reported"
echo "=== revert --yes ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/mf-rev.out || fail "revert non-zero"
sleep 3
echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert (revert no-op bug)"
echo "=== confirm live FilterPattern restored to '\"ERROR\"' ==="
GOT="$(aws logs describe-metric-filters --log-group-name "$LG" --filter-name-prefix "$FN" --region "$REGION" --query "metricFilters[?filterName=='$FN'].filterPattern" --output text)"
[ "$GOT" = '"ERROR"' ] || fail "live FilterPattern not restored (got: $GOT)"
echo "INTEG PASS ($STACK)"

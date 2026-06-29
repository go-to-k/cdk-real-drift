#!/usr/bin/env bash
# Metric-math Alarm detect + revert (real AWS): flip the declared MUTABLE Threshold
# 5->9 out of band (put-metric-alarm upsert, preserving the Metrics array) -> check
# MUST DETECT -> revert (Cloud Control UpdateResource) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegMathAlarm; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out al.json al2.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
ANAME="$(aws cloudwatch describe-alarms --region "$REGION" --query "MetricAlarms[?contains(AlarmName,'CdkRealDriftIntegMathAlarm')].AlarmName" --output text | head -1)"
[ -n "$ANAME" ] && [ "$ANAME" != "None" ] || fail "no alarm name"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob Threshold 5->9 (preserve Metrics array) ==="
aws cloudwatch describe-alarms --alarm-names "$ANAME" --region "$REGION" --query "MetricAlarms[0]" > al.json
node -e "const a=require('./al.json');const p={AlarmName:a.AlarmName,ComparisonOperator:a.ComparisonOperator,EvaluationPeriods:a.EvaluationPeriods,Threshold:9,Metrics:a.Metrics,...(a.TreatMissingData?{TreatMissingData:a.TreatMissingData}:{}),...(a.AlarmDescription?{AlarmDescription:a.AlarmDescription}:{})};require('fs').writeFileSync('al2.json',JSON.stringify(p));"
aws cloudwatch put-metric-alarm --cli-input-json file://al2.json --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mathalarm-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Threshold" /tmp/cdkrd-mathalarm-detect.out || fail "Threshold drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws cloudwatch describe-alarms --alarm-names "$ANAME" --region "$REGION" --query 'MetricAlarms[0].Threshold' --output text)"
[ "$GOT" = "5.0" ] || fail "Threshold not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

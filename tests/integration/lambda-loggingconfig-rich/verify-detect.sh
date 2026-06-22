#!/usr/bin/env bash
# Lambda LoggingConfig detect + revert integration test (real AWS): the "someone
# changed the log level in the console" scenario. Deploy -> record -> change the
# DECLARED MUTABLE LoggingConfig out of band (ApplicationLogLevel INFO->DEBUG,
# SystemLogLevel WARN->INFO) -> check MUST DETECT the declared drift (exit 1) ->
# revert -> check MUST be CLEAN and the live LoggingConfig MUST be restored. This
# is the false-negative / detection half (a nested LoggingConfig property), which
# the plain record->check->CLEAN verify.sh does not exercise.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLambdaLoggingConfigRich
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

FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN" ] || fail "could not resolve function physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: LoggingConfig ApplicationLogLevel INFO->DEBUG, SystemLogLevel WARN->INFO ==="
aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
  --logging-config "LogFormat=JSON,ApplicationLogLevel=DEBUG,SystemLogLevel=INFO" >/dev/null \
  || fail "inject drift"
aws lambda wait function-updated --function-name "$FN" --region "$REGION"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-lambda-logging-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "ApplicationLogLevel" /tmp/cdkrd-lambda-logging-detect.out || fail "ApplicationLogLevel not reported"

echo "=== revert (write declared LoggingConfig back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live LoggingConfig MUST be restored to INFO / WARN ==="
GOT="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query "LoggingConfig.[ApplicationLogLevel,SystemLogLevel]" --output text)"
[ "$GOT" = "INFO	WARN" ] || fail "live LoggingConfig not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

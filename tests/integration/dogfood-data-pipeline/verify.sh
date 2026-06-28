#!/usr/bin/env bash
# DOGFOOD false-positive integration test (real AWS): a realistic streaming DATA
# PIPELINE — a Kinesis data stream feeding a Firehose delivery stream that runs a
# Lambda transform (ProcessingConfiguration with Parameters) and lands GZIP'd objects
# in S3 with CloudWatch error logging, plus a Glue database + table catalog. Unlike
# the single-type fixtures this exercises the INTERACTION of Kinesis + Firehose (its
# nested ProcessingConfiguration / S3 destination config) + Glue + S3 + the Lambda
# transform + the IAM delivery role wiring them. It also exercises the LogStream
# CC_IDENTIFIER_ADAPTERS composite read (a read-gap this stack surfaced). A clean
# `record` -> `check` MUST be CLEAN; any declared drift is a default-folding FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDogfoodDataPipeline
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

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

echo "=== [$STACK] check MUST be CLEAN (no interaction FP; LogStream read via adapter) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }
# the LogStream read-gap fix must hold: it must NOT be in the skipped footer
grep -q "AWS::Logs::LogStream.*ValidationException" "/tmp/cdkrd-$STACK.out" && fail "LogStream still skipped (read-gap regression)"

echo "INTEG PASS ($STACK)"

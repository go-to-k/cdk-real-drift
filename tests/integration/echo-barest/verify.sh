#!/usr/bin/env bash
# False-positive integration test (real AWS): the barest Lambda/ECR/StepFunctions/
# Kinesis bundle. Every service-materialized default (SnapStart, ImageScanning,
# LoggingConfiguration, TracingConfiguration, StreamEncryption, …) must fold to
# atDefault. deploy -> check (pre-record) MUST be CLEAN -> record -> check MUST be
# CLEAN. Any [Potential Drift] on this un-mutated stack is a fold gap (a bug).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntEcho0714
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

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.pre.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FIRST-RUN FALSE POSITIVE ---"; fail "expected CLEAN pre-record (exit 0), got $rc"; }

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

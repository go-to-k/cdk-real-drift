#!/usr/bin/env bash
# False-positive test: a barest Events::Rule + Kinesis::Stream must FIRST-check CLEAN
# (State ENABLED and RetentionPeriodHours 24 fold to atDefault) and stay CLEAN after record.
set -uo pipefail
export AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevertToggle0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

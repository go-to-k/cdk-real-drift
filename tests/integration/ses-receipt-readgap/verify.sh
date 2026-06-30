#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSesReceiptReadGap
# SES inbound receipt rules exist only in us-east-1 / us-west-2 / eu-west-1.
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
echo "=== [$STACK] pre-record check (harvest + assert NO read-gap) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-$STACK" $CLI check "$STACK" --region "$REGION" --verbose 2>&1 | tee "/tmp/cdkrd-prerecord-$STACK.out" || true
if grep -qE "skipped=[1-9]" "/tmp/cdkrd-prerecord-$STACK.out"; then
  echo "--- READ-GAP: $STACK has skipped resources ---"; fail "expected every resource READ (skipped=0)"
fi
echo "=== [$STACK] record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail 2>&1 | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK ---"; fail "expected CLEAN (exit 0), got $rc"; }
echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# Read-gap integration test (real AWS): deploy -> check MUST read every resource
# (no `skipped=`) -> record -> check MUST be CLEAN. A composite-id child type whose
# CFn physical id is only the child segment is silently `skipped` by Cloud Control
# until CC_IDENTIFIER_ADAPTERS derives the parent|child composite; this asserts the
# resource is actually READ (not vacuously clean because it was skipped).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwDocVersionRich
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

echo "=== [$STACK] pre-record check (harvest + assert NO read-gap) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-$STACK" $CLI check "$STACK" --region "$REGION" --verbose 2>&1 | tee "/tmp/cdkrd-prerecord-$STACK.out" || true
if grep -qE "skipped=[1-9]" "/tmp/cdkrd-prerecord-$STACK.out"; then
  echo "--- READ-GAP: $STACK has skipped resources (composite-id not adapted) ---"
  fail "expected every resource READ (skipped=0)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail 2>&1 | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# False-positive integration test (real AWS): barest ApiGatewayV2 Model + Deployment (composite-adapter probe)
# 
# deploy -> first check (pre-record) MUST be CLEAN (zero [Potential Drift] —
# grep the output, the exit code is 0 on baseline-less potential drift) ->
# record -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714WsExt
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
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
if grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out"; then
  echo "--- FIRST-RUN FALSE POSITIVE ---"
  fail "expected zero [Potential Drift] on first check"
fi

# A composite-id adapter gap surfaces as skipped= in the info footer — that is
# the read gap this fixture exists to catch.
if grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out"; then
  fail "resources were skipped (composite-identifier read gap)"
fi

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

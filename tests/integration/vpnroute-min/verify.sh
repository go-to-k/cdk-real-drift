#!/usr/bin/env bash
# Integration test (real AWS): static VPNConnection + VPNConnectionRoute ->
# FIRST check (pre-record) must show ZERO drift AND ZERO skipped (a skipped=
# on the route = the composite-primaryIdentifier read-gap) -> record -> CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714VpnRoute
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture (~10 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): drift-free AND no skipped route ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
if grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out"; then
  fail "first check must be drift-free (VPN fold gap)"
fi
if grep -q "skipped=" "/tmp/cdkrd-$STACK.first.out"; then
  fail "no resource may be skipped (VPNConnectionRoute composite-id read-gap)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# cdk-real-drift CC-identifier-adapter integration test — R129.
#
# Composite-identifier types that read as a Cloud Control ValidationException skip
# with the bare CFn physical id, until the R129 CC_IDENTIFIER_ADAPTERS pair each with
# its parent (parent-first `|`) — or, for ApiGateway::Deployment, child-first:
#   ApiGateway Model / RequestValidator / Resource / Stage / Deployment,
#   Cognito UserPoolDomain / UserPoolResourceServer.
# Asserts:
#   1. fresh deploy `check` exits 0 with ZERO declared drift (harvest invariant);
#   2. NO "ValidationException" skip remains (the adapters made these types READABLE);
#   3. `record --yes` then `check --fail` is CLEAN.
#
# CDKRD_CCADAPTERS_KEEP=1 skips the destroy for debug iteration.
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/ccadapters && npm install && bash verify-ccadapters.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkdriftIntegCcAdapters
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-ccadapters.out

cleanup() {
  if [ -n "${CDKRD_CCADAPTERS_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_CCADAPTERS_KEEP set) — destroy manually when done ---"
    return
  fi
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (composite-identifier types) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== 1. baseline-free check: ZERO declared drift AND no ValidationException skip ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"
# the whole point: the composite-id types must now READ, not skip as ValidationException
grep -q "ValidationException" "$OUT" && fail "a CC ValidationException skip remains — an adapter is missing/wrong"

echo "=== 2. record + check --fail must be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS"

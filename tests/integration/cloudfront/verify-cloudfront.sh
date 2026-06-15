#!/usr/bin/env bash
# cdk-real-drift CloudFront corpus integration test (real AWS) — R75.
#
# CloudFront is the most config-dense CFn type and materializes service
# defaults for nearly everything the template omits — the corpus previously
# had only hand-written seeds for it. Asserts the two harvest invariants:
#   1. fresh deploy classifies with ZERO declared drift (exit 0) — this
#      stresses the Id-keyed Origins sort, the HTTP-method enum-set sort,
#      and the policy-reference shapes against real data;
#   2. record --yes then check --fail lands CLEAN.
# Slow fixture (deploy/destroy take minutes each) — separate from the
# harvest waves so their fast loop stays fast.
#
# CDKRD_CLOUDFRONT_KEEP=1 skips the destroy for debug iteration.
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/cloudfront && npm install && bash verify-cloudfront.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdIntegCloudfront
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-cloudfront.out

cleanup() {
  if [ -n "${CDKRD_CLOUDFRONT_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_CLOUDFRONT_KEEP set) — destroy manually when done ---"
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

echo "=== deploy fixture (CloudFront distribution; takes minutes) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== 1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== 2. record + check --fail must be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS"

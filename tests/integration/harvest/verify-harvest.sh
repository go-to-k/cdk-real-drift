#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test (real AWS) — R71.
#
# Deploys ~18 cheap resource types the corpus had never seen live, then:
#   1. baseline-free `check` — a FRESH deploy must classify with ZERO declared
#      drift across every type (the cross-type false-positive test), exit 0
#      (everything undeclared is UNRECORDED);
#   2. `record --yes` then `check --fail` — the baseline round trip must land
#      CLEAN (exit 0) across every type;
#   3. destroy. Nothing lingers (no KMS keys, secrets, or hosted zones).
#
# Run with CDKRD_CORPUS_DIR=<dir> to record one golden-corpus case per type —
# the whole point: one AWS round trip becomes permanent offline coverage.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest && npm install && bash verify-harvest.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdIntegHarvest
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest.out

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (~18 types) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --verbose | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== record + check --fail must be CLEAN across every type ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS"

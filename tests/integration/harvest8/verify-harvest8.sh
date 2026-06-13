#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test wave 8 (real AWS) — R90.
#
# Cheap, low-dependency CFn types NOT yet in the golden corpus (115 distinct types
# before this wave): WAFv2 RegexPatternSet, Logs QueryDefinition, ServiceDiscovery
# HttpNamespace + Service, Glue SecurityConfiguration + Workflow, IAM Group, Route53
# CidrCollection, EventSchemas Registry + Schema, CodeDeploy Application, SES
# Template, CloudWatch AnomalyDetector. Asserts the two harvest invariants:
#   1. baseline-free `check` — fresh deploy = ZERO declared drift, exit 0;
#   2. `accept --yes` then `check --fail` — CLEAN across every type.
#
# CDKRD_HARVEST8_KEEP=1 skips the destroy for debug iteration.
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest8 && npm install && bash verify-harvest8.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkdriftIntegHarvest8
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest8.out

cleanup() {
  if [ -n "${CDKRD_HARVEST8_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_HARVEST8_KEEP set) — destroy manually when done ---"
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

echo "=== deploy fixture (wave 8: uncovered cheap types) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== 1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== 2. accept + check --fail must be CLEAN across every type ==="
$CLI accept "$STACK" --region "$REGION" --yes || fail "accept"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after accept"

echo "INTEG PASS"

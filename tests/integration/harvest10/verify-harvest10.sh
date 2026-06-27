#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test wave 10 (real AWS) — R125.
#
# Uncovered config-dense (but cheap) CFn types: CloudFront CachePolicy /
# OriginRequestPolicy / ResponseHeadersPolicy / Function / PublicKey / KeyGroup,
# AppMesh Mesh + VirtualNode, Lambda LayerVersion + EventInvokeConfig, Kinesis
# StreamConsumer, Logs SubscriptionFilter, ECS Service (Fargate, desiredCount 0),
# ServiceDiscovery PrivateDnsNamespace + Service. Asserts the two harvest invariants:
#   1. baseline-free `check` — fresh deploy = ZERO declared drift, exit 0;
#   2. `record --yes` then `check --fail` — CLEAN across every type.
#
# CDKRD_HARVEST10_KEEP=1 skips the destroy for debug iteration.
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest10 && npm install && bash verify-harvest10.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkdriftIntegHarvest10
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest10.out

cleanup() {
  if [ -n "${CDKRD_HARVEST10_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_HARVEST10_KEEP set) — destroy manually when done ---"
    return
  fi
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (wave 10: uncovered config-dense types) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== 1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "CFn-Declared Drift" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== 2. record + check --fail must be CLEAN across every type ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS"

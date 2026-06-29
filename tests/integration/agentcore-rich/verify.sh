#!/usr/bin/env bash
# cdk-real-drift agentcore-rich false-positive integration test (real AWS).
# Deploy -> check --fail (no baseline) MUST exit 0 (no declared drift; every declared
# value normalizes equal to live) -> record -> check stays CLEAN. A normalizer/read
# regression turns a declared value into a false declared drift and fails here.
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAgentCore
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-agentcore-rich-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift on a noise-prone property (exit $rc) — a normalizer regressed"
grep -q "CFn-Declared Drift" /tmp/cdkrd-agentcore-rich-pre.out \
  && fail "a declared property was wrongly reported as drift (false positive)"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS ($STACK)"

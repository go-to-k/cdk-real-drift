#!/usr/bin/env bash
# cdk-real-drift CloudWatch metric-math Alarm false-positive integration test (real AWS).
#
# Deploys a MathExpression alarm (Metrics array of MetricStat + Expression elements).
# The strong assertion: with NO baseline, `check --fail` must exit 0 — every declared
# value normalizes equal to live despite AWS default-filling each Metrics element
# (ReturnData, MetricStat Period) and possibly reordering the Id-keyed array. A
# normalizer regression turns one into a false declared drift and fails here. Then
# record + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# Usage:  cd tests/integration/cloudwatch-mathalarm && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMathAlarm
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-mathalarm $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true

echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mathalarm-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift on a metric-math alarm (exit $rc) — a normalizer regressed"
grep -q "CFn-Declared Drift" /tmp/cdkrd-mathalarm-pre.out \
  && fail "a declared property was wrongly reported as drift (false positive)"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS"

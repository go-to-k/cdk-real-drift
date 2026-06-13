#!/usr/bin/env bash
# cdk-real-drift EventBridge false-positive integration test (real AWS, R88).
#
# Deploys resources that DECLARE noise-prone properties (see app.ts) whose live AWS
# form is textually different but semantically equal. The strong assertion: with NO
# baseline, `check --fail` must exit 0 — there is no declared drift, because every
# declared value normalizes equal to live. A normalizer regression turns one into a
# false declared drift and fails here. Then accept + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# Usage:  cd tests/integration/eventbridge && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEvents
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-eventbridge-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift on a noise-prone property (exit $rc) — a normalizer regressed"
grep -q "DECLARED DRIFT" /tmp/cdkrd-eventbridge-pre.out \
  && fail "a declared property was wrongly reported as drift (false positive)"

echo "=== accept then check must stay CLEAN ==="
$CLI accept "$STACK" --region "$REGION" --yes || fail "accept"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after accept"

echo "INTEG PASS"

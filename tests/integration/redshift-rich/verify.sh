#!/usr/bin/env bash
# cdk-real-drift redshift-rich integration test (real AWS).
# The "clean deploy -> ZERO potential drift" invariant oracle (CLAUDE.md / DESIGN.md):
# deploy -> check BEFORE record MUST show no [Potential Drift] (every undeclared value
# is an AWS-assigned initial/default and must fold to atDefault) -> record -> check
# stays CLEAN. A missing fold regresses the invariant and fails here. A cleanup trap
# destroys even on failure, so a failed run leaves no orphans.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRedshiftRich
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

echo "=== check BEFORE record: ZERO potential drift + no declared FP ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-redshift-rich-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift (exit $rc)"
grep -q "CFn-Declared Drift" /tmp/cdkrd-redshift-rich-pre.out && fail "a declared property was wrongly reported as drift"
grep -q "Potential Drift" /tmp/cdkrd-redshift-rich-pre.out \
  && fail "clean deploy has [Potential Drift] — an AWS-assigned initial value is not folded (invariant regressed)"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS ($STACK)"

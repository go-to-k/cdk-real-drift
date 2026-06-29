#!/usr/bin/env bash
# cdk-real-drift NetworkAclEntry read-gap integration test (real AWS).
# AWS::EC2::NetworkAclEntry has no Cloud Control read handler, so before the SDK_OVERRIDES
# reader every entry was silently `skipped`. This asserts the entries are now actually READ
# (NOT skipped) and that a freshly deployed + recorded NACL reports CLEAN (no FP from the
# new reader's field mapping — Protocol number-coercion, PortRange, Icmp, Egress).
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegNaclEntry
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
$CLI check "$STACK" --region "$REGION" --fail --verbose | tee /tmp/cdkrd-naclentry-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift (exit $rc) — the NetworkAclEntry reader mapping regressed"
grep -q "CFn-Declared Drift" /tmp/cdkrd-naclentry-pre.out \
  && fail "a NetworkAclEntry property was wrongly reported as drift (false positive)"

echo "=== NetworkAclEntry entries must be READ, not skipped (UnsupportedActionException) ==="
grep -E "NetworkAclEntry.*(UnsupportedActionException|CC API)" /tmp/cdkrd-naclentry-pre.out \
  && fail "NetworkAclEntry still skipped — the SDK_OVERRIDES reader did not take effect"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS ($STACK)"

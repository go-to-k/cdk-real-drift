#!/usr/bin/env bash
# Rich false-positive integration test (real AWS).
#   deploy fixture -> record baseline -> check MUST be CLEAN.
# A freshly deployed + recorded stack with NO out-of-band change must report no
# drift; any drift reported here is a normalization / default-folding false positive.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRichFp
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-rich-fp.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: check reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS"

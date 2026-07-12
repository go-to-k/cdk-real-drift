#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy the barest DAX stack -> the FIRST
# check (before record) MUST be CLEAN (#1532: ParameterNameValues / ParameterGroupName /
# PreferredMaintenanceWindow / default SecurityGroupIds all fold) -> record -> check CLEAN.
# NOTE: a DAX cluster takes ~10-15 minutes to create.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntDax0712c
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN (#1532) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

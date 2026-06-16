#!/usr/bin/env bash
# cdk-real-drift nested-stack coverage-WARNING integration test (real AWS).
#
# A CDK `NestedStack` deploys as a separate child CloudFormation stack. cdkrd checks
# the parent's `AWS::CloudFormation::Stack` resource but does NOT recurse into the
# child, so the child's resources are unchecked. A drift tool silently under-covering
# is the danger; this asserts `check` LOUDLY warns about the nested stack (so a CLEAN
# verdict is never silently incomplete), and that the parent itself reads CLEAN.
#
#   deploy parent (+ nested child) -> record -> check
#     -> assert the nested-stack coverage WARNING is printed
#     -> assert the parent stack is otherwise CLEAN
# A cleanup trap destroys the stack + removes the baseline even on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegNested
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

echo "=== deploy parent + nested child ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check: must LOUDLY warn about the nested stack (coverage gap) ==="
OUT=/tmp/cdk-real-drift-integ-nested.out
$CLI check "$STACK" --region "$REGION" 2>&1 | tee "$OUT"
grep -qi "nested CloudFormation stack" "$OUT" || fail "no nested-stack coverage warning printed"
grep -qi "NOT checked" "$OUT" || fail "warning did not say the child resources are NOT checked"

echo "=== parent stack itself should be CLEAN (warning is on stderr, not drift) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN exit 0 (the warning must not be counted as drift)"

echo "INTEG PASS"

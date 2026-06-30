#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. CDK wraps the instance's UserData in Fn::Base64(Fn::Join/Fn::Sub);
# the resolver now resolves Fn::Base64, so the declared UserData is compared against
# the live (base64) value instead of being left UNRESOLVED. A clean recorded instance
# with NO out-of-band change must report no drift — any drift here is an FP proving
# base64(resolved declared) != live UserData.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEc2UserData
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

# The whole point of the change: UserData must be RESOLVED (compared), not skipped as
# an unresolved intrinsic. Assert it is not sitting in the unresolved tier.
if $CLI check "$STACK" --region "$REGION" --verbose 2>&1 | grep -A40 "Unresolved" | grep -q "Host.UserData"; then
  fail "UserData still UNRESOLVED — Fn::Base64 not resolved"
fi
echo "UserData is resolved (not in the unresolved tier)."

echo "INTEG PASS ($STACK)"

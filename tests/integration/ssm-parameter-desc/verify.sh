#!/usr/bin/env bash
# SSM::Parameter writeOnly-read-gap integration test (real AWS).
#
# AWS::SSM::Parameter `Description` and `AllowedPattern` are `writeOnlyProperties`
# in the CFn registry schema, so Cloud Control GetResource never echoes them — an
# out-of-band console edit to the description used to be SILENTLY invisible to cdkrd.
# The SDK_SUPPLEMENTS reader now lifts both from ssm:DescribeParameters and merges
# them onto the CC model. This test proves, end to end:
#   1. clean record -> check is CLEAN (the supplement is FP-safe), and
#   2. an out-of-band Description edit is DETECTED (no false negative), and
#   3. revert writes the declared Description back and check is CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSsmParameterDesc
REGION="${AWS_REGION:-us-east-1}"
PARAM=/cdkrd-integ/ssm-parameter-desc/value
CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

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

echo "=== [$STACK] check MUST be CLEAN (supplement is FP-safe) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.clean.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] mutate Description out of band (the writeOnly read-gap) ==="
aws ssm put-parameter --name "$PARAM" --value "hello" --type String \
  --description "TAMPERED out of band" --allowed-pattern '^[a-z]+$' --overwrite --region "$REGION" >/dev/null || fail "put-parameter"

echo "=== [$STACK] check MUST DETECT the Description drift (no false negative) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.drift.out"
rc=${PIPESTATUS[0]}
[ "$rc" -ne 0 ] || { echo "--- FALSE NEGATIVE: Description edit not detected ---"; fail "expected drift (exit 1), got $rc"; }
grep -qi "Description" "/tmp/cdkrd-$STACK.drift.out" || fail "drift output does not mention Description"

echo "=== [$STACK] revert (write declared Description back to AWS) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] live Description must be back to the declared value ==="
LIVE=$(aws ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=$PARAM" --region "$REGION" --query 'Parameters[0].Description' --output text)
[ "$LIVE" = "declared description" ] || fail "revert did not restore Description (got: $LIVE)"

echo "=== [$STACK] check MUST be CLEAN again after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert (exit 0), got $rc"

echo "INTEG PASS ($STACK)"

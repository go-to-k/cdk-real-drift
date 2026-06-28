#!/usr/bin/env bash
# SSM::Parameter Tier writeOnly-read-gap integration test (real AWS).
#
# Tier is writeOnly, so Cloud Control never echoes it — an out-of-band Standard<->Advanced
# change (a real billing difference) was silently invisible. The SDK_SUPPLEMENTS reader
# projects Tier from ssm:DescribeParameters. This test proves: clean record -> check is
# CLEAN (undeclared Standard folds via KNOWN_DEFAULTS; a declared Intelligent-Tiering does
# NOT false-flag against the resolved tier), an out-of-band Tier upgrade is DETECTED, and
# revert reports it not-revertable (AWS forbids an advanced->standard downgrade via update).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSsmTierReadgap
REGION="${AWS_REGION:-us-east-1}"
STD=/cdkrd-integ/ssm-tier/std
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

echo "=== [$STACK] check MUST be CLEAN (Standard folds; Intelligent-Tiering resolution is no FP) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.clean.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] mutate Tier Standard -> Advanced out of band ==="
aws ssm put-parameter --name "$STD" --value "hello" --type String --tier Advanced --overwrite --region "$REGION" >/dev/null || fail "put-parameter"

echo "=== [$STACK] check MUST DETECT the Tier drift (no false negative) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.drift.out"
rc=${PIPESTATUS[0]}
[ "$rc" -ne 0 ] || { echo "--- FALSE NEGATIVE: Tier change not detected ---"; fail "expected drift (exit 1), got $rc"; }
grep -qi "Tier" "/tmp/cdkrd-$STACK.drift.out" || fail "drift output does not mention Tier"

# Reverting this drift means downgrading Advanced->Standard, which AWS forbids via
# update (delete + recreate is the only path) — so cdkrd reports it not-revertable
# rather than emit a PutParameter that always fails. Detection is the shipped value.
echo "=== [$STACK] revert reports the Tier downgrade not-revertable (AWS blocks it) ==="
$CLI revert "$STACK" --region "$REGION" --dry-run | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qi "NOT revertable" "/tmp/cdkrd-$STACK.revert.out" || fail "expected Tier downgrade reported NOT revertable"
grep -qi "downgrade" "/tmp/cdkrd-$STACK.revert.out" || fail "expected the advanced-tier downgrade reason"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# cdk-real-drift NESTED-undeclared integration test (real AWS) — R96/R98/R99.
#
# Reuses the DynamoDB fixture (app.ts), which materializes two kinds of nested
# undeclared value the template never declares:
#   - R98 (identity-keyed ARRAY element): GlobalSecondaryIndexes[gsi1].WarmThroughput
#   - R96 (object-nested):                PointInTimeRecoverySpecification.RecoveryPeriodInDays
#
# Asserts the full live chain:
#   1. baseline-free check FOLDS nested into the info: footer (`undeclared-subkey=N`), exit 0;
#   2. --show-all expands BOTH the R98 bracketed path and the R96 dotted path;
#   3. record --yes then check --fail is CLEAN (record records the nested values);
#   4. a REAL out-of-band mutation of the undeclared RecoveryPeriodInDays (35 -> 20
#      via update-continuous-backups) surfaces as an undeclared DRIFT (check --fail
#      exits 1) on the nested path — proving the baseline gate works at depth;
#   5. revert reports that nested drift as NOT-revertable (R99: a flat Cloud Control
#      JSON-Pointer patch can't safely target a deep sub-field) — never attempts a
#      malformed patch.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# CDKRD_NESTED_KEEP=1 skips the destroy for debug iteration.
# Usage:  cd tests/integration/dynamodb && npm install && bash verify-nested.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDynamoDB
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
TABLE=""

cleanup() {
  if [ -n "${CDKRD_NESTED_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_NESTED_KEEP set) — destroy manually when done ---"
    return
  fi
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

TABLE=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId | [0]" \
  --output text)
[ -n "$TABLE" ] && [ "$TABLE" != "None" ] || fail "could not resolve the table physical id"
echo "table: $TABLE"

echo "=== 1. baseline-free check: nested values FOLD into the info footer ==="
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-nested-1.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (inventory only), got $rc"
grep -q "CFn-Declared Drift" /tmp/cdkrd-nested-1.out && fail "fresh deploy reported DECLARED drift"
grep -qE "undeclared-subkey=[1-9]" /tmp/cdkrd-nested-1.out || fail "expected an 'undeclared-subkey=N' fold in the info footer"

echo "=== 2. --show-all expands BOTH the R98 array-element and R96 object-nested paths ==="
$CLI check "$STACK" --region "$REGION" --show-all | tee /tmp/cdkrd-nested-2.out
grep -qE "GlobalSecondaryIndexes\[gsi1\]\.WarmThroughput" /tmp/cdkrd-nested-2.out \
  || fail "expected the R98 array-element nested path GlobalSecondaryIndexes[gsi1].WarmThroughput"
grep -qE "PointInTimeRecoverySpecification\.RecoveryPeriodInDays" /tmp/cdkrd-nested-2.out \
  || fail "expected the R96 object-nested path PointInTimeRecoverySpecification.RecoveryPeriodInDays"

echo "=== 3. record then check --fail must be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== 4. REAL mutation: change the undeclared RecoveryPeriodInDays 35 -> 20 ==="
aws dynamodb update-continuous-backups --table-name "$TABLE" --region "$REGION" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true,RecoveryPeriodInDays=20 \
  >/dev/null || fail "update-continuous-backups mutation failed"
# the nested undeclared value now diverges from the recorded baseline -> drift
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-nested-4.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected exit 1 (nested undeclared drift) after the mutation"
grep -qE "PointInTimeRecoverySpecification\.RecoveryPeriodInDays" /tmp/cdkrd-nested-4.out \
  || fail "the nested undeclared drift was not reported on the RecoveryPeriodInDays path"

echo "=== 5. revert reports the nested drift as NOT-revertable (R99) ==="
$CLI revert "$STACK" --region "$REGION" --dry-run --verbose | tee /tmp/cdkrd-nested-5.out
grep -qi "nested undeclared" /tmp/cdkrd-nested-5.out \
  || fail "revert did not mark the nested value not-revertable (R99 guard missing)"
# and it must NOT have built a (malformed) patch op for it
grep -q "RecoveryPeriodInDays.*-> " /tmp/cdkrd-nested-5.out \
  && fail "revert built an op for a nested value — the R99 guard let it through"

echo "INTEG PASS"

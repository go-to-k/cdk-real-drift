#!/usr/bin/env bash
# Revert-gap integration test (real AWS): RDS modifications can queue in
# pending-modified-values unless applied immediately. deploy -> record -> modify
# BackupRetentionPeriod out of band -> check MUST detect -> revert -> the live value
# MUST actually be restored (not left pending) -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRdsBackupRetentionRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

DB=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].PhysicalResourceId" --output text)
[ -n "$DB" ] || fail "no db id"
echo "db=$DB"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] modify BackupRetentionPeriod 7 -> 1 out of band ==="
aws rds modify-db-instance --db-instance-identifier "$DB" --backup-retention-period 1 \
  --apply-immediately --region "$REGION" >/dev/null || fail "modify"
aws rds wait db-instance-available --db-instance-identifier "$DB" --region "$REGION" || true

echo "=== [$STACK] check MUST detect ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "expected detection, got CLEAN — FALSE NEGATIVE"

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"
aws rds wait db-instance-available --db-instance-identifier "$DB" --region "$REGION" || true

echo "=== [$STACK] live BackupRetentionPeriod after revert ==="
BRP=$(aws rds describe-db-instances --db-instance-identifier "$DB" --region "$REGION" \
  --query 'DBInstances[0].BackupRetentionPeriod' --output text)
echo "BackupRetentionPeriod=$BRP"
[ "$BRP" = "7" ] || fail "REVERT-GAP: BackupRetentionPeriod not restored (got $BRP — left pending?)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"

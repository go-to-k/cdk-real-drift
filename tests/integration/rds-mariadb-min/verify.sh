#!/usr/bin/env bash
# False-positive + revert-convergence integration test (real AWS), #1541:
# barest non-Aurora mariadb DBInstance (the engine variant with no prior corpus
# coverage) -> FIRST check (pre-record) must show ZERO drift -> record -> check
# CLEAN -> out-of-band undeclared BackupRetentionPeriod 1->3 must be DETECTED ->
# revert must CONVERGE the live value back to 1 (ModifyDBInstance ignores an
# omitted property, so this pins the REVERT_SET_DEFAULT_PATHS entry).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713RdsMariadb
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture (~10 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): every drift line is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
if grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out"; then
  fail "first check must be drift-free (mariadb variant fold gap)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

DBID=$(aws rds describe-db-instances --region "$REGION" \
  --query "DBInstances[?contains(DBInstanceIdentifier,'cdkrdhunt0713rdsmariadb')].DBInstanceIdentifier|[0]" --output text)
[ -n "$DBID" ] && [ "$DBID" != "None" ] || fail "resolve DBID"

echo "=== [$STACK] out-of-band BackupRetentionPeriod 1->3 MUST be detected ==="
aws rds modify-db-instance --db-instance-identifier "$DBID" --backup-retention-period 3 --apply-immediately --region "$REGION" >/dev/null || fail "mutate"
for i in $(seq 1 30); do
  ST=$(aws rds describe-db-instances --db-instance-identifier "$DBID" --region "$REGION" --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod]' --output text)
  case "$ST" in available*3) break;; esac
  sleep 20
done
$CLI check "$STACK" --region "$REGION" --fail
[ "$?" -eq 1 ] || fail "expected drift exit 1 after out-of-band retention change"

echo "=== [$STACK] revert MUST converge the live value back to 1 (#1541) ==="
$CLI revert "$STACK" --region "$REGION" --remove-unrecorded --yes || fail "revert"
for i in $(seq 1 30); do
  V=$(aws rds describe-db-instances --db-instance-identifier "$DBID" --region "$REGION" --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod]' --output text)
  case "$V" in available*1) break;; esac
  sleep 20
done
V=$(aws rds describe-db-instances --db-instance-identifier "$DBID" --region "$REGION" --query 'DBInstances[0].BackupRetentionPeriod' --output text)
[ "$V" = "1" ] || fail "live BackupRetentionPeriod is $V, expected 1 — #1541 silent no-op regression"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# rds-replica-hunt integration (real AWS), three legs:
#   FP leg:     first check (pre-record) must be ZERO [Potential Drift] — covers the
#               replica derived defaults (#1704) AND the mixed-case reference echoes.
#   FN leg:     OOB BackupRetentionPeriod change on the replica must be DETECTED.
#   Revert leg: `revert` must restore the replica's BRP to the DERIVED default 0
#               (the static KNOWN_DEFAULTS value is 1 — writing 1 is the bug).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRdsReplicaHunt
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

# poll_brp <db-id> <expected> — RDS applies BRP online; wait-available returns before
# propagation, so poll the describe surface until the value lands (#1582 gotcha).
poll_brp() {
  local id="$1" want="$2" got=""
  for _ in $(seq 1 60); do
    got=$(aws rds describe-db-instances --db-instance-identifier "$id" --region "$REGION" \
      --query 'DBInstances[0].BackupRetentionPeriod' --output text 2>/dev/null)
    [ "$got" = "$want" ] && return 0
    sleep 10
  done
  echo "BRP still $got (wanted $want)"
  return 1
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
REPLICA=$(aws cloudformation describe-stack-resource --stack-name "$STACK" \
  --logical-resource-id Replica --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
echo "replica: $REPLICA"

echo "=== [$STACK] FIRST check (pre-record): every [Potential Drift] is a fold gap ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.first.out" && fail "first check shows [Potential Drift] — fold gap"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] OOB: replica BackupRetentionPeriod 0 -> 3 ==="
aws rds modify-db-instance --db-instance-identifier "$REPLICA" \
  --backup-retention-period 3 --apply-immediately --region "$REGION" \
  --query 'DBInstance.PendingModifiedValues' --output json || fail "modify-db-instance"
poll_brp "$REPLICA" 3 || fail "OOB BRP change did not propagate"
# The value flips in describe while the instance is still `modifying` — a revert fired
# then hits ResourceConflict ("Database instance is not in available state", live
# 2026-08-02). Wait for available before asserting/reverting.
aws rds wait db-instance-available --db-instance-identifier "$REPLICA" --region "$REGION" \
  || fail "replica did not return to available after the OOB modify"

echo "=== [$STACK] check MUST detect (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detection (exit 1), got $rc"
grep -q "BackupRetentionPeriod" "/tmp/cdkrd-$STACK.detect.out" || fail "BRP drift not in output"

echo "=== [$STACK] revert MUST restore the DERIVED default 0 (not the static 1) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
poll_brp "$REPLICA" 0 || fail "revert wrote the wrong value — live BRP is not the derived 0"

echo "=== [$STACK] final check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert (exit 0), got $rc"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# Zero-corpus cheap-tail probe (CapacityReservation, Route 53 Profiles +
# association, NetworkInsightsPath): deploy, assert the FIRST check (before
# record) is CLEAN, then record and assert check --fail stays clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0721Zc
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (zerocorpus-hunt): $*"; exit 1; }

echo "=== deploy ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

echo "=== FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-zerocorpus}" $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC)"

echo "=== record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "=== FN leg: OOB InstanceMatchCriteria mutate must be DETECTED ==="
CR_ID=$(aws ec2 describe-capacity-reservations --region "$REGION" \
  --filters Name=state,Values=active "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
  --query 'CapacityReservations[0].CapacityReservationId' --output text)
[ -n "$CR_ID" ] && [ "$CR_ID" != "None" ] || fail "capacity reservation id not found"
aws ec2 modify-capacity-reservation --region "$REGION" \
  --capacity-reservation-id "$CR_ID" --instance-match-criteria targeted >/dev/null || fail "oob mutate"
sleep 5
$CLI check "$STACK" --region "$REGION" --fail && fail "OOB InstanceMatchCriteria change NOT detected (FN)"

echo "=== revert must restore 'open' (set-default write — a bare remove silently no-ops) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
IMC=$(aws ec2 describe-capacity-reservations --region "$REGION" \
  --capacity-reservation-ids "$CR_ID" \
  --query 'CapacityReservations[0].InstanceMatchCriteria' --output text)
[ "$IMC" = "open" ] || fail "revert did not restore InstanceMatchCriteria (live=$IMC)"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG OK (zerocorpus-hunt)"

#!/usr/bin/env bash
# Free-pack first-run FP probe (real AWS): deploy both stacks, assert the FIRST
# check (before record) is CLEAN, record, assert check --fail clean; then the FN
# leg — mutate the declared ASG MaxSize out of band, assert check --fail exits 1,
# revert, assert clean + the live value converged back.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACKS=(CdkrdHunt0801FreeA CdkrdHunt0801FreeB)
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup (${STACKS[*]}) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (freepack-hunt): $*"; exit 1; }

echo "=== deploy (both stacks) ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
  CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-freepack0801}" $CLI check "$STACK" --region "$REGION" --fail \
    | tee "/tmp/cdkrd-$STACK.pre.out"
  RC=${PIPESTATUS[0]}
  # `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] first check not clean (rc=$RC)"

  echo "=== [$STACK] record + check --fail ==="
  $CLI record "$STACK" --region "$REGION" --yes || fail "[$STACK] record"
  $CLI check "$STACK" --region "$REGION" --fail || fail "[$STACK] post-record check not clean"
done

echo "=== FN leg: OOB-mutate declared ASG MaxSize (0 -> 2) ==="
ASG_NAME=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
  --query 'AutoScalingGroups[?starts_with(AutoScalingGroupName, `CdkrdHunt0801FreeA-MipAsg`)].AutoScalingGroupName' \
  --output text)
[ -n "$ASG_NAME" ] || fail "ASG not found"
aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG_NAME" \
  --max-size 2 --region "$REGION" || fail "OOB mutate"
sleep 10

echo "=== check MUST detect (exit 1) ==="
$CLI check CdkrdHunt0801FreeA --region "$REGION" --fail
RC=$?
[ "$RC" -eq 1 ] || fail "expected drift exit 1, got $RC"

echo "=== revert MUST converge MaxSize back to 0 ==="
$CLI revert CdkrdHunt0801FreeA --region "$REGION" --yes | tee "/tmp/cdkrd-freeA.revert.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "revert rc"
grep -q "NOT reverted" "/tmp/cdkrd-freeA.revert.out" && fail "revert reported NOT reverted"
sleep 10
LIVE_MAX=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG_NAME" \
  --region "$REGION" --query 'AutoScalingGroups[0].MaxSize' --output text)
[ "$LIVE_MAX" = "0" ] || fail "live MaxSize not reverted (got $LIVE_MAX)"

echo "=== post-revert check MUST be CLEAN ==="
$CLI check CdkrdHunt0801FreeA --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG OK (freepack-hunt)"

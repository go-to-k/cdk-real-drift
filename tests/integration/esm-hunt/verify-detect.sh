#!/usr/bin/env bash
# Detect + revert-convergence probe for the #1608 folds (real AWS): mutate the
# two newly folded MUTABLE stream-ESM surfaces out of band -> check MUST DETECT
# -> revert -> check MUST be CLEAN -> the LIVE values MUST be back at their
# defaults (a silent no-op revert is the #1571 class; only this live test
# answers whether the Lambda CC handler converges a bare `remove`).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714Esm
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?LogicalResourceId=='$1'].PhysicalResourceId" --output text
}

# ESM updates transition through State=Updating; poll until the field reflects
# the expected value (async-update convergence, the #1519 lesson).
wait_esm_field() { # uuid jmespath expected
  for _ in $(seq 1 36); do
    v="$(aws lambda get-event-source-mapping --uuid "$1" --region "$REGION" \
      --query "$2" --output text 2>/dev/null)"
    [ "$v" = "$3" ] && return 0
    sleep 5
  done
  echo "last value: $v"
  return 1
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN (the #1608 fix, live), then record ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP still present after the fold fix"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

DDB_ESM="$(phys HuntDdbEsm)"
KIN_ESM="$(phys HuntKinesisEsm)"

echo "=== [$STACK] mutate out of band (2 surfaces) ==="
aws lambda update-event-source-mapping --uuid "$DDB_ESM" --region "$REGION" \
  --parallelization-factor 5 >/dev/null || fail "mutate parallelization"
aws lambda update-event-source-mapping --uuid "$KIN_ESM" --region "$REGION" \
  --tumbling-window-in-seconds 30 >/dev/null || fail "mutate tumbling window"
wait_esm_field "$DDB_ESM" 'ParallelizationFactor' 5 || fail "parallelization mutation not settled"
wait_esm_field "$KIN_ESM" 'TumblingWindowInSeconds' 30 || fail "tumbling mutation not settled"

echo "=== [$STACK] check MUST DETECT both ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
grep -q "ParallelizationFactor" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: ParallelizationFactor"
grep -q "TumblingWindowInSeconds" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: TumblingWindowInSeconds"

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged path (see output)"
wait_esm_field "$DDB_ESM" 'State' Enabled || fail "DDB ESM not settled after revert"
wait_esm_field "$KIN_ESM" 'State' Enabled || fail "Kinesis ESM not settled after revert"

echo "=== [$STACK] live values MUST be back at their defaults ==="
wait_esm_field "$DDB_ESM" 'ParallelizationFactor' 1 || fail "ParallelizationFactor did not converge (revert no-op)"
wait_esm_field "$KIN_ESM" 'TumblingWindowInSeconds' 0 || fail "TumblingWindowInSeconds did not converge (revert no-op)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK detect+revert, #1608)"

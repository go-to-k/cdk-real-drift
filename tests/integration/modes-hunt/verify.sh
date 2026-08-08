#!/usr/bin/env bash
# modes-hunt (2026-08-09): first-run FP probe over the ECS BLUE_GREEN deployment
# family + CloudFront VpcOrigin barest config (see app.ts). deploy -> FIRST
# check (pre-record) must be CLEAN and error-free -> record -> check --fail
# CLEAN -> FN probe on BakeTimeInMinutes (OOB update-service -> detect ->
# revert -> live restored).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0809Modes
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S.*\(AWS::' || true
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN and error-free ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-modes}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored (exit != 0)"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }
grep -E "skipped=|readGap=|unresolved=" "/tmp/cdkrd-$STACK.first.out" || true

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] FN probe: OOB BakeTimeInMinutes change -> detect -> revert ==="
aws ecs update-service --cluster cdkrd-hunt-0809-modes --service cdkrd-hunt-0809-bg \
  --deployment-configuration 'strategy=BLUE_GREEN,bakeTimeInMinutes=5' \
  --region "$REGION" >/dev/null || fail "oob update-service"
for i in $(seq 1 20); do
  BT=$(aws ecs describe-services --cluster cdkrd-hunt-0809-modes --services cdkrd-hunt-0809-bg \
    --region "$REGION" --query 'services[0].deploymentConfiguration.bakeTimeInMinutes' --output text)
  [ "$BT" = "5" ] && break
  sleep 5
done
[ "$BT" = "5" ] || fail "OOB update did not propagate (bakeTimeInMinutes=$BT)"
$CLI check "$STACK" --region "$REGION" --fail && fail "BakeTimeInMinutes drift NOT detected (FN)"
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -E "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence"
for i in $(seq 1 20); do
  BT=$(aws ecs describe-services --cluster cdkrd-hunt-0809-modes --services cdkrd-hunt-0809-bg \
    --region "$REGION" --query 'services[0].deploymentConfiguration.bakeTimeInMinutes' --output text)
  [ "$BT" = "0" ] && break
  sleep 5
done
[ "$BT" = "0" ] || fail "revert did not restore bakeTimeInMinutes (live=$BT)"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

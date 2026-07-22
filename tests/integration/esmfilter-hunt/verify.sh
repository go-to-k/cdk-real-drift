#!/usr/bin/env bash
# ESM probes: (1) FilterCriteria.Filters reorder FP on the SQS ESM; (2) barest
# Kinesis ESM first-run fold; (3) ParallelizationFactor OOB mutate -> detect ->
# revert -> LIVE convergence (bare-remove no-op class).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722Esm
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-esmfilter}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"
grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out" && fail "resources skipped (read gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "=== [$STACK] FN probe: mutate Kinesis ESM ParallelizationFactor 1->3 OOB ==="
KESM_UUID="$(aws lambda list-event-source-mappings --region "$REGION" \
  --query "EventSourceMappings[?contains(EventSourceArn, 'HuntStream')].UUID" --output text)"
[ -n "$KESM_UUID" ] || fail "could not find Kinesis ESM UUID"
aws lambda update-event-source-mapping --uuid "$KESM_UUID" --parallelization-factor 3 --region "$REGION" >/dev/null || fail "OOB mutate"
sleep 20

$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.mut.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "MISSED DETECTION: expected exit 1 after OOB ParallelizationFactor change (got $rc)"

echo "=== [$STACK] revert + live convergence ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.rev.out" || fail "revert errored"
sleep 20
LIVE_PF="$(aws lambda get-event-source-mapping --uuid "$KESM_UUID" --region "$REGION" --query 'ParallelizationFactor' --output text)"
[ "$LIVE_PF" = "1" ] || fail "REVERT NO-OP: live ParallelizationFactor=$LIVE_PF (expected 1) — RSDP candidate"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG PASS ($STACK)"

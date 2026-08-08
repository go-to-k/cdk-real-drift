#!/usr/bin/env bash
# t1pack-hunt (2026-08-09): first-run FP probe over eight unexercised free/instant
# surfaces (see app.ts). deploy -> FIRST check (pre-record) must be CLEAN and
# error-free -> record -> check --fail CLEAN -> FN probe on the DynamoDB
# OnDemandThroughput caps (OOB update-table -> detect -> revert -> live restored).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0809T1Pack
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
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-t1pack}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored (exit != 0)"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }
grep -E "skipped=|readGap=|unresolved=" "/tmp/cdkrd-$STACK.first.out" || true

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] FN probe: OOB OnDemandThroughput change -> detect -> revert ==="
aws dynamodb update-table --table-name cdkrd-hunt-0809-odt --region "$REGION" \
  --on-demand-throughput MaxReadRequestUnits=10,MaxWriteRequestUnits=10 >/dev/null || fail "oob update-table"
aws dynamodb wait table-exists --table-name cdkrd-hunt-0809-odt --region "$REGION"
for i in $(seq 1 20); do
  RU=$(aws dynamodb describe-table --table-name cdkrd-hunt-0809-odt --region "$REGION" \
    --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text)
  [ "$RU" = "10" ] && break
  sleep 5
done
[ "$RU" = "10" ] || fail "OOB update did not propagate (MaxReadRequestUnits=$RU)"
$CLI check "$STACK" --region "$REGION" --fail && fail "OnDemandThroughput drift NOT detected (FN)"
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -E "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence"
for i in $(seq 1 20); do
  RU=$(aws dynamodb describe-table --table-name cdkrd-hunt-0809-odt --region "$REGION" \
    --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text)
  [ "$RU" = "5" ] && break
  sleep 5
done
[ "$RU" = "5" ] || fail "revert did not restore MaxReadRequestUnits (live=$RU)"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

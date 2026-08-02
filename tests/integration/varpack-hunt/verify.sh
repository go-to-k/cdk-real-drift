#!/usr/bin/env bash
# varpack-hunt (2026-08-03): first-run FP probe over eight unexercised cheap
# variants (see app.ts). deploy -> FIRST check (pre-record) must be CLEAN and
# error-free -> record -> check --fail CLEAN -> FN probe on the StringList
# parameter (OOB put-parameter -> detect -> revert -> live value restored).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0803VarPack
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
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+ \(AWS::' || true
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN and error-free ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-varpack}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored (exit != 0)"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }
grep -E "skipped=|readGap=|unresolved=" "/tmp/cdkrd-$STACK.first.out" || true

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] FN probe: OOB StringList value change -> detect -> revert ==="
aws ssm put-parameter --name cdkrd-hunt-varpack-0803-list --type StringList \
  --value "alpha,beta,gamma,delta" --overwrite --region "$REGION" >/dev/null || fail "oob put-parameter"
$CLI check "$STACK" --region "$REGION" --fail && fail "StringList drift NOT detected (FN)"
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
LIVE_VAL=$(aws ssm get-parameter --name cdkrd-hunt-varpack-0803-list --region "$REGION" --query 'Parameter.Value' --output text)
[ "$LIVE_VAL" = "alpha,beta,gamma" ] || fail "revert did not restore StringList value (live=$LIVE_VAL)"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

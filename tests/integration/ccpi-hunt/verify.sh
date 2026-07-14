#!/usr/bin/env bash
# Composite-primaryIdentifier read-gap probe (real AWS): deploy the association
# pack and assert (1) NO resource is silently skipped for a composite-id
# ValidationException (the #344 class), (2) the first check is CLEAN, and
# (3) record -> check --fail stays clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714CcPi
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

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN + zero skipped ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-ccpi}" $CLI check "$STACK" --region "$REGION" --fail --verbose \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
# The probe's whole point: a skipped= footer here is a composite-id read gap.
grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out" && RC=11
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC; 11 = skipped resources)"

echo "=== [$STACK] record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "INTEG OK (ccpi-hunt)"

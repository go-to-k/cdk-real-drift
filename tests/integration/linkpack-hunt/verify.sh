#!/usr/bin/env bash
# Wave-2 probe (2026-08-11 hunt): deploy the link/association pack, assert the
# FIRST check (before record) is CLEAN — a false `added` on the Glue link's
# proxied tables (#1749) or the merged AppSync API's inherited children, or a
# reorder [Potential Drift] on the ECS capacity-provider association, is the bug
# being probed — then record and assert check --fail stays clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0811LinkPack
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (linkpack-hunt): $*"; exit 1; }

echo "=== deploy ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

echo "=== FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-linkpack}" $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
grep -qE "created out of band|\[Added\]" "/tmp/cdkrd-$STACK.pre.out" && RC=11
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC)"

echo "=== record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "INTEG OK (linkpack-hunt)"

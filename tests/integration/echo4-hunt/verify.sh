#!/usr/bin/env bash
# Post-update echo probe over post-2026-07-14 fold types (UDP TGs, DLM, Lambda PC
# alias, Route 53 policy records, Budgets fixed + auto-adjusting): deploy, assert
# the FIRST check (before record) is CLEAN, record, then redeploy with -c rev=2
# (real per-resource updates) and assert the re-check stays CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0721Echo4
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (echo4-hunt): $*"; exit 1; }

echo "=== deploy ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

echo "=== FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-echo4}" $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
# `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC)"

echo "=== record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "=== redeploy with -c rev=2 (post-update echo probe) ==="
npx cdk deploy -f --all --require-approval never -c rev=2 || fail "redeploy rev=2"

echo "=== post-update check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.rev2.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.rev2.out" && RC=10
[ "$RC" -eq 0 ] || fail "post-update check not clean (rc=$RC)"

echo "INTEG OK (echo4-hunt)"

#!/usr/bin/env bash
# Cross-stack Fn::ImportValue false-positive integration test (real AWS):
# deploy BOTH stacks -> first check (pre-record, all stacks) MUST show zero
# [Potential Drift] and zero unresolved -> record -> check MUST be CLEAN.
# Any drift/unresolved on the consumer's ImportValue-consuming declared props is a
# cross-stack resolution bug (exports prefetch / intrinsic resolver).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
PROD=CdkrdHuntXstkProd
CONS=CdkrdHuntXstkCons
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($PROD + $CONS) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f --all >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (xstack-importvalue): $*"; exit 1; }

echo "=== [xstack] deploy both stacks ==="
npx cdk deploy --all -f --require-approval never || fail "deploy"

echo "=== [xstack] FIRST check (pre-record, all stacks) MUST show zero Potential Drift / unresolved ==="
FIRST_OUT="/tmp/cdkrd-xstack-first.out"
$CLI check --region "$REGION" | tee "$FIRST_OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -le 1 ] || fail "first check errored (exit $rc)"
grep -q "Potential Drift" "$FIRST_OUT" && { echo "--- FIRST-RUN FP: undeclared value surfaced on a fresh cross-stack deploy ---"; fail "expected zero [Potential Drift] pre-record"; }
grep -q "unresolved=" "$FIRST_OUT" && { echo "--- UNRESOLVED: an ImportValue-consuming declared prop did not resolve ---"; fail "expected zero unresolved"; }

echo "=== [xstack] record (write baselines for both stacks) ==="
$CLI record --region "$REGION" --yes || fail "record"

echo "=== [xstack] check MUST be CLEAN ==="
$CLI check --region "$REGION" --fail | tee "/tmp/cdkrd-xstack.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: cross-stack app reported drift on a clean recorded deploy ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS (xstack-importvalue)"

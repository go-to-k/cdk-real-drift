#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> FIRST check (pre-record)
# must show ZERO drift -> record -> check MUST be CLEAN. See app.ts for the
# probe inventory and live determinations.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713bAcctSingletons
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

if aws logs describe-account-policies --policy-type DATA_PROTECTION_POLICY --region "$REGION" --query "accountPolicies[0]" --output text 2>/dev/null | grep -qv None; then fail "account already has a data-protection policy — singleton, aborting"; fi
if aws ecr get-registry-policy --region "$REGION" >/dev/null 2>&1; then fail "account already has an ECR registry policy — singleton, aborting"; fi

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): every drift line is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out" && fail "first check must be drift-free"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

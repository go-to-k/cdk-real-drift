#!/usr/bin/env bash
# Missed-detection + revert integration test (real AWS): deploy -> record -> mutate the
# declared AccessString out of band (the "someone granted +@write in the console"
# scenario) -> check MUST detect (exit 1; #482: the writeOnly AccessString used to be
# invisible to the CC read) -> revert MUST restore it -> check MUST be CLEAN.
# ElastiCache user updates are ASYNC (Status: modifying -> active), so each step
# settle-waits on the user status.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCacheUsers
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK detect): $*"; exit 1; }
settle() {
  for _ in $(seq 1 60); do
    st=$(aws elasticache describe-users --user-id cdkrd-hunt-reader --region "$REGION" \
      --query 'Users[0].Status' --output text 2>/dev/null)
    [ "$st" = "active" ] && return 0
    sleep 5
  done
  fail "user never settled (status=$st)"
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate out of band: grant +@write on the reader user ==="
aws elasticache modify-user --user-id cdkrd-hunt-reader \
  --access-string "on ~app:* +@read +@write" --region "$REGION" >/dev/null || fail "modify-user"
settle

echo "=== [$STACK] check MUST detect (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected detect exit 1, got $rc"
grep -q "AccessString" "/tmp/cdkrd-$STACK-detect.out" || fail "AccessString not in findings"

echo "=== [$STACK] revert MUST restore the declared ACL (async: --wait) ==="
$CLI revert "$STACK" --region "$REGION" --yes --wait | tee "/tmp/cdkrd-$STACK-revert.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "revert"
settle

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

LIVE=$(aws elasticache describe-users --user-id cdkrd-hunt-reader --region "$REGION" \
  --query 'Users[0].AccessString' --output text)
case "$LIVE" in
  *"+@write"*) fail "live access string still grants +@write: $LIVE" ;;
esac

echo "INTEG PASS ($STACK detect+revert)"

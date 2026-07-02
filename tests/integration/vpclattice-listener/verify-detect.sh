#!/usr/bin/env bash
# Missed-detection + revert integration test (real AWS): deploy -> record -> mutate a
# declared MUTABLE prop out of band (Rule Priority via update-rule) -> check MUST
# detect (exit 1) -> revert MUST succeed (#481: the CC update used to fail on the
# service-echoed empty Match.HttpMatch.HeaderMatches) -> check MUST be CLEAN and the
# live priority restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLatticeListener
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK detect): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

SVC=$(aws vpc-lattice list-services --region "$REGION" --query "items[?name=='cdkrd-hunt-svc'].id" --output text)
LIS=$(aws vpc-lattice list-listeners --service-identifier "$SVC" --region "$REGION" --query "items[0].id" --output text)
RULE=$(aws vpc-lattice list-rules --service-identifier "$SVC" --listener-identifier "$LIS" --region "$REGION" --query "items[?name=='cdkrd-hunt-rule'].id" --output text)
[ -n "$RULE" ] || fail "rule id lookup"

echo "=== [$STACK] mutate out of band: Rule Priority 10 -> 20 ==="
aws vpc-lattice update-rule --service-identifier "$SVC" --listener-identifier "$LIS" \
  --rule-identifier "$RULE" --priority 20 --region "$REGION" >/dev/null || fail "update-rule"

echo "=== [$STACK] check MUST detect (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected detect exit 1, got $rc"
grep -q "Priority" "/tmp/cdkrd-$STACK-detect.out" || fail "Priority not in findings"

echo "=== [$STACK] revert MUST succeed (#481 strip of the empty HeaderMatches echo) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK-revert.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "revert"
grep -q "FAILED" "/tmp/cdkrd-$STACK-revert.out" && fail "revert reported a FAILED item"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

LIVEP=$(aws vpc-lattice get-rule --service-identifier "$SVC" --listener-identifier "$LIS" \
  --rule-identifier "$RULE" --region "$REGION" --query priority --output text)
[ "$LIVEP" = "10" ] || fail "live priority not restored: $LIVEP"

echo "INTEG PASS ($STACK detect+revert)"

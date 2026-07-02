#!/usr/bin/env bash
# Missed-detection (FN) integration test (real AWS): with the resolver-rich stack
# DEPLOYED and RECORDED (run by verify.sh first, or standalone), mutate the
# mutable ResolverRule TargetIps out of band -> `check --fail` MUST detect
# (exit 1) -> `revert --yes` MUST restore the declared targets -> `check --fail`
# MUST be CLEAN again. Run while the stack is still up; does NOT deploy or
# clean up.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegResolverRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
fail() { echo "INTEG FAIL ($STACK detect): $*"; exit 1; }

RULE_ID=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ResolverRuleId'].OutputValue" --output text)
[ -n "$RULE_ID" ] || fail "could not resolve ResolverRuleId output"

echo "=== [$STACK] mutate ResolverRule TargetIps out of band (rule $RULE_ID) ==="
aws route53resolver update-resolver-rule --resolver-rule-id "$RULE_ID" --region "$REGION" \
  --config 'TargetIps=[{Ip=10.9.9.9,Port=53}]' >/dev/null || fail "mutate TargetIps"

# Resolver rule updates are ASYNC (status UPDATING) — a revert issued mid-update
# is rejected with RSLVR-00705. Wait for the rule to settle before checking.
for _ in $(seq 1 30); do
  ST=$(aws route53resolver get-resolver-rule --resolver-rule-id "$RULE_ID" --region "$REGION" \
    --query 'ResolverRule.Status' --output text)
  [ "$ST" = "COMPLETE" ] && break
  sleep 5
done
[ "$ST" = "COMPLETE" ] || fail "rule did not settle after mutation (status $ST)"

echo "=== [$STACK] check MUST detect the TargetIps drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detection (exit 1), got $rc"
grep -q "TargetIps" "/tmp/cdkrd-$STACK-detect.out" || fail "drift output does not mention TargetIps"

echo "=== [$STACK] revert MUST restore the declared TargetIps ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE_IPS=$(aws route53resolver get-resolver-rule --resolver-rule-id "$RULE_ID" --region "$REGION" \
  --query 'ResolverRule.TargetIps[].Ip' --output text | tr '\t' ' ')
case "$LIVE_IPS" in
  *10.0.0.53*10.0.0.54*|*10.0.0.54*10.0.0.53*) : ;;
  *) fail "live TargetIps not restored (got: $LIVE_IPS)" ;;
esac

echo "INTEG PASS ($STACK detect)"

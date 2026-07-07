#!/usr/bin/env bash
# FN half (real AWS): mutate a DECLARED mutable property out of band (classic ELB
# HealthCheck.Interval 30->15) and assert `check` DETECTS it, `revert` restores it,
# and a re-check is CLEAN. Then repeat for an UNDECLARED folded default
# (ConnectionSettings.IdleTimeout 60->120) to prove the equality-gate re-surfaces an
# out-of-band change and revert converges it back to the default.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElbClassicRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
LB="$(cat /tmp/elb-lbname.txt)"; fail(){ echo "DETECT FAIL: $*"; exit 1; }

echo "=== record baseline (clean) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record

echo "=== A: mutate DECLARED HealthCheck.Interval 30->15 out of band ==="
aws elb configure-health-check --load-balancer-name "$LB" --region "$REGION" \
  --health-check Target=HTTP:80/,Interval=15,Timeout=5,UnhealthyThreshold=5,HealthyThreshold=2 >/dev/null || fail mutate-hc
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 1 ] || fail "expected DETECT (exit 1) got $rc for HealthCheck mutation"
echo "  -> detected. revert:"
$CLI revert "$STACK" --region "$REGION" --yes || fail revert-hc
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after HealthCheck revert got $rc"
echo "  -> HealthCheck revert CLEAN"

echo "=== B: mutate UNDECLARED folded ConnectionSettings.IdleTimeout 60->120 ==="
aws elb modify-load-balancer-attributes --load-balancer-name "$LB" --region "$REGION" \
  --load-balancer-attributes "ConnectionSettings={IdleTimeout=120}" >/dev/null || fail mutate-idle
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 1 ] || fail "expected DETECT (exit 1) got $rc for IdleTimeout mutation (equality-gate)"
echo "  -> detected. revert:"
$CLI revert "$STACK" --region "$REGION" --yes || fail revert-idle
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after IdleTimeout revert got $rc"
IDLE=$(aws elb describe-load-balancer-attributes --load-balancer-name "$LB" --region "$REGION" \
  --query 'LoadBalancerAttributes.ConnectionSettings.IdleTimeout' --output text)
[ "$IDLE" = "60" ] || fail "IdleTimeout not restored to 60 (live=$IDLE) — revert was a silent no-op"
echo "  -> IdleTimeout restored to 60 live"
echo "DETECT+REVERT PASS ($STACK)"

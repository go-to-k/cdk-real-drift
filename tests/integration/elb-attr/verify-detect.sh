#!/usr/bin/env bash
# ELB attribute detect + revert (real AWS), the FN this fixture exists to pin:
#  (a) DECLARED attribute (idle_timeout.timeout_seconds 120->300) MUST be detected as
#      declared drift and reverted via the ModifyLoadBalancerAttributes SDK writer.
#  (b) UNDECLARED attribute (routing.http.drop_invalid_header_fields.enabled false->true,
#      a security-relevant attribute the template never declared) changed AFTER record
#      MUST now be detected as UNDECLARED drift (the fail-closed fix). Before the fix
#      this was a permanent silent FN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElbAttr; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
LBARN="$(aws elbv2 describe-load-balancers --names cdkrd-elb-attr --region "$REGION" --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
[ -n "$LBARN" ] && [ "$LBARN" != "None" ] || fail "no LB arn"
echo "=== record (snapshots the full attribute bag) ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== (a) DECLARED idle_timeout 120->300 ==="
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$LBARN" --attributes Key=idle_timeout.timeout_seconds,Value=300 --region "$REGION" >/dev/null || fail "inject declared"
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-elb-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 (declared) got $rc"
grep -qi "idle_timeout" /tmp/cdkrd-elb-detect.out || fail "declared idle_timeout not reported"
echo "=== revert declared ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$LBARN" --region "$REGION" --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value" --output text)"
[ "$GOT" = "120" ] || fail "idle_timeout not restored (got $GOT)"
echo "=== (b) UNDECLARED routing.http.drop_invalid_header_fields.enabled false->true (FN fix) ==="
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$LBARN" --attributes Key=routing.http.drop_invalid_header_fields.enabled,Value=true --region "$REGION" >/dev/null || fail "inject undeclared"
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-elb-undeclared.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 (undeclared attr change) got $rc — FN regression"
grep -qi "drop_invalid_header_fields" /tmp/cdkrd-elb-undeclared.out || fail "undeclared attr drift not reported — FN regression"
echo "INTEG PASS ($STACK detect declared+undeclared)"

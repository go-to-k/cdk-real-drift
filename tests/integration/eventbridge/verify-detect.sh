#!/usr/bin/env bash
# EventBridge Rule detect + revert (real AWS): flip the declared MUTABLE State
# ENABLED->DISABLED out of band (disable-rule) -> check MUST DETECT -> revert (CC) ->
# CLEAN + restored. (Common event-routing resource; revert via Cloud Control.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegEvents; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
RN="$(aws events list-rules --region "$REGION" --query "Rules[?contains(Name,'CdkRealDriftIntegEvents')].Name" --output text | head -1)"
[ -n "$RN" ] && [ "$RN" != "None" ] || fail "no rule name"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob State ENABLED->DISABLED ==="
aws events disable-rule --name "$RN" --region "$REGION" || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-events-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "State" /tmp/cdkrd-events-detect.out || fail "State drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws events describe-rule --name "$RN" --region "$REGION" --query State --output text)"
[ "$GOT" = "ENABLED" ] || fail "State not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

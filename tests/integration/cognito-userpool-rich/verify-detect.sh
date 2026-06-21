#!/usr/bin/env bash
# Cognito UserPool detect + revert (real AWS): flip the declared MUTABLE MFA config
# OPTIONAL->OFF out of band (dedicated set-user-pool-mfa-config API, no collateral) ->
# check MUST DETECT -> revert (CC) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegCognitoUserPoolRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
PID="$(aws cognito-idp list-user-pools --max-results 50 --region "$REGION" --query "UserPools[?Name=='cdkrd-userpool-rich'].Id" --output text)"
[ -n "$PID" ] && [ "$PID" != "None" ] || fail "no user pool id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob MFA OPTIONAL->OFF ==="
aws cognito-idp set-user-pool-mfa-config --user-pool-id "$PID" --mfa-configuration OFF --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-cog-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Mfa" /tmp/cdkrd-cog-detect.out || fail "mfa drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "$PID" --region "$REGION" --query 'MfaConfiguration' --output text)"
[ "$GOT" = "OPTIONAL" ] || fail "mfa not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

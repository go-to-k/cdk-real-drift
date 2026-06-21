#!/usr/bin/env bash
# AppSync ApiKey detect integration test (real AWS). AWS::AppSync::ApiKey is a Cloud
# Control read gap (GetResource -> UnsupportedActionException, NON_PROVISIONABLE), so
# before the ListApiKeys SDK override a declared key was `skipped`. Proves: (1) the key
# is now READ — record->check is CLEAN (the FP-prone Expires, which AWS rounds DOWN to
# the hour, folds via the epoch-hour equivalence); (2) a genuine Expires change to a
# DIFFERENT hour is DETECTED (the equivalence does not mask real drift). No revert
# writer (Expires is hour-rounded), so this is detect-only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegAppsyncGraphqlapiRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
APIID="$(aws appsync list-graphql-apis --region "$REGION" --query "graphqlApis[?name=='cdkrd-appsync-rich'].apiId" --output text)"
KID="$(aws appsync list-api-keys --api-id "$APIID" --region "$REGION" --query 'apiKeys[0].id' --output text)"
[ -n "$KID" ] && [ "$KID" != "None" ] || fail "no api key"
echo "=== record + check MUST be CLEAN (ApiKey read; Expires hour-equiv folds) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN (Expires FP?)"
echo "=== oob Expires +2h (different hour) -> MUST DETECT ==="
CUR="$(aws appsync list-api-keys --api-id "$APIID" --region "$REGION" --query 'apiKeys[0].expires' --output text)"
aws appsync update-api-key --api-id "$APIID" --id "$KID" --expires $((CUR + 7200)) --region "$REGION" >/dev/null || fail inject
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-apikey-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Expires" /tmp/cdkrd-apikey-detect.out || fail "Expires drift not reported"
echo "INTEG PASS ($STACK ApiKey read + Expires detect)"

#!/usr/bin/env bash
# AppSync GraphQLApi detect + revert (real AWS): flip the declared MUTABLE xrayEnabled
# true->false out of band -> check MUST DETECT -> revert (CC) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegAppsyncGraphqlapiRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
APIID="$(aws appsync list-graphql-apis --region "$REGION" --query "graphqlApis[?name=='cdkrd-appsync-rich'].apiId" --output text)"
[ -n "$APIID" ] && [ "$APIID" != "None" ] || fail "no api id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob xrayEnabled true->false ==="
aws appsync update-graphql-api --api-id "$APIID" --name cdkrd-appsync-rich --authentication-type API_KEY --no-xray-enabled --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-appsync-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Xray" /tmp/cdkrd-appsync-detect.out || fail "xray drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws appsync get-graphql-api --api-id "$APIID" --region "$REGION" --query 'graphqlApi.xrayEnabled' --output text)"
[ "$GOT" = "True" ] || fail "xray not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

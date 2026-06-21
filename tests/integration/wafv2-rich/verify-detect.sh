#!/usr/bin/env bash
# WAFv2 WebACL detect + revert (real AWS). The revert is the point: CloudFront-style,
# WAFv2's Cloud Control UpdateResource REJECTS a property patch — it re-validates the
# whole WebACL and AWS's own empty Description trips the schema pattern. Revert goes
# through the GetWebACL->UpdateWebACL SDK writer (which omits the empty Description).
# Drift the declared MUTABLE VisibilityConfig.SampledRequestsEnabled true->false out of
# band (a scalar; DefaultAction is a mutually-exclusive union and is a separate case) ->
# check MUST DETECT -> revert (SDK writer) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegWafv2Rich; NAME=cdkrd-wafv2-rich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out waf.json rules.json vc.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
ID="$(aws wafv2 list-web-acls --scope REGIONAL --region "$REGION" --query "WebACLs[?Name=='$NAME'].Id" --output text)"
[ -n "$ID" ] && [ "$ID" != "None" ] || fail "no web acl id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob SampledRequestsEnabled true->false (full-config update) ==="
aws wafv2 get-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --region "$REGION" > waf.json
LOCK="$(node -e "console.log(require('./waf.json').LockToken)")"
node -e "const w=require('./waf.json').WebACL;require('fs').writeFileSync('rules.json',JSON.stringify(w.Rules));require('fs').writeFileSync('vc.json',JSON.stringify({...w.VisibilityConfig,SampledRequestsEnabled:false}));"
aws wafv2 update-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --lock-token "$LOCK" --default-action Allow={} --rules file://rules.json --visibility-config file://vc.json --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-waf-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "SampledRequestsEnabled" /tmp/cdkrd-waf-detect.out || fail "drift not reported"
echo "=== revert (SDK writer: UpdateWebACL, omits empty Description) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-waf-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-waf-revert.out || fail "revert did not converge (CC-revalidation regression?)"
GOT="$(aws wafv2 get-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --region "$REGION" --query 'WebACL.VisibilityConfig.SampledRequestsEnabled' --output text)"
[ "$GOT" = "True" ] || fail "SampledRequestsEnabled not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

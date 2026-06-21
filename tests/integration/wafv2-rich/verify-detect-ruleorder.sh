#!/usr/bin/env bash
# WAFv2 WebACL per-RULE revert index-alignment (real AWS). classify SORTS Rules by Name
# (every rule carries one), so a per-rule drift finding is indexed in the SORTED space
# ([AWSCommon=0, RateLimit=1]). GetWebACL returns Rules in their configured order, which
# this fixture declares REVERSED ([RateLimit, AWSCommon]). The SDK writer must canonicalize
# the live model before applying the patch, or an op at /Rules/1 lands on the WRONG rule
# (AWSCommon, which has no RateBasedStatement) — corrupting an unrelated security rule and
# leaving the real drift unreverted. Drift RateLimit's rateBasedStatement.limit 2000->5000
# out of band -> check MUST detect at the RateLimit rule -> revert -> CLEAN + limit restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegWafv2Rich; NAME=cdkrd-wafv2-rich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out waf.json rules.json vc.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
ID="$(aws wafv2 list-web-acls --scope REGIONAL --region "$REGION" --query "WebACLs[?Name=='$NAME'].Id" --output text)"
[ -n "$ID" ] && [ "$ID" != "None" ] || fail "no web acl id"

echo "=== confirm live rule order is [RateLimit, AWSCommon] (raw != Name-sorted) ==="
aws wafv2 get-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --region "$REGION" > waf.json
ORDER="$(node -e "console.log(require('./waf.json').WebACL.Rules.map(r=>r.Name).join(','))")"
echo "live raw rule order: $ORDER"
[ "$ORDER" = "RateLimit,AWSCommon" ] || echo "WARN: raw order is '$ORDER' (test still valid as long as != AWSCommon,RateLimit)"
[ "$ORDER" != "AWSCommon,RateLimit" ] || fail "raw order == Name-sorted order; fixture does not exercise misalignment"

echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== baseline check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN before drift"

echo "=== oob drift: RateLimit rule rateBasedStatement.limit 2000 -> 5000 ==="
LOCK="$(node -e "console.log(require('./waf.json').LockToken)")"
node -e "const w=require('./waf.json').WebACL;const r=w.Rules.find(x=>x.Name==='RateLimit');if(!r||!r.Statement||!r.Statement.RateBasedStatement)throw new Error('RateLimit rule shape unexpected');r.Statement.RateBasedStatement.Limit=5000;require('fs').writeFileSync('rules.json',JSON.stringify(w.Rules));require('fs').writeFileSync('vc.json',JSON.stringify(w.VisibilityConfig));"
aws wafv2 update-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --lock-token "$LOCK" --default-action Allow={} --rules file://rules.json --visibility-config file://vc.json --region "$REGION" >/dev/null || fail inject

echo "=== check MUST DETECT the RateLimit-rule drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-waf-ruleorder.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Limit" /tmp/cdkrd-waf-ruleorder.out || fail "drift not reported on rule Limit"

echo "=== revert (SDK writer must align Rules to sorted index, hit RateLimit not AWSCommon) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-waf-ruleorder-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-waf-ruleorder-revert.out || fail "revert did not converge (wrong-rule patch / index misalignment?)"

echo "=== confirm RateLimit.Limit restored to 2000 AND AWSCommon untouched ==="
GOT="$(aws wafv2 get-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --region "$REGION" --query "WebACL.Rules[?Name=='RateLimit'].Statement.RateBasedStatement.Limit | [0]" --output text)"
[ "$GOT" = "2000" ] || fail "RateLimit.Limit not restored (got $GOT)"
AWSC="$(aws wafv2 get-web-acl --name "$NAME" --id "$ID" --scope REGIONAL --region "$REGION" --query "WebACL.Rules[?Name=='AWSCommon'].Statement.ManagedRuleGroupStatement.Name | [0]" --output text)"
[ "$AWSC" = "AWSManagedRulesCommonRuleSet" ] || fail "AWSCommon rule corrupted by misaligned patch (got $AWSC)"
echo "INTEG PASS ($STACK per-rule revert index-alignment)"

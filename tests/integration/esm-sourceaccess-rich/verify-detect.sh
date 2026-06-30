#!/usr/bin/env bash
# Lambda EventSourceMapping detect + revert (real AWS). Drift the declared MUTABLE
# BatchSize 100->50 out of band (the "someone changed it in the console" scenario)
# -> check MUST DETECT -> revert (Cloud Control UpdateResource) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegEsmSourceaccessRich; FN=cdkrd-esm-consumer; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
export AWS_CLI_AUTO_PROMPT=off
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
UUID="$(aws lambda list-event-source-mappings --function-name "$FN" --region "$REGION" --query 'EventSourceMappings[0].UUID' --output text)"
[ -n "$UUID" ] && [ "$UUID" != "None" ] || fail "no esm uuid"
wait_enabled(){ while [ "$(aws lambda get-event-source-mapping --uuid "$UUID" --region "$REGION" --query State --output text 2>/dev/null)" = "Updating" ]; do sleep 5; done; }
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob BatchSize 100->50 ==="
aws lambda update-event-source-mapping --uuid "$UUID" --batch-size 50 --region "$REGION" >/dev/null || fail inject
wait_enabled
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-esm-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "BatchSize" /tmp/cdkrd-esm-detect.out || fail "drift not reported"
echo "=== revert (Cloud Control UpdateResource) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-esm-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-esm-revert.out || fail "revert did not converge"
wait_enabled
GOT="$(aws lambda get-event-source-mapping --uuid "$UUID" --region "$REGION" --query BatchSize --output text)"
[ "$GOT" = "100" ] || fail "BatchSize not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

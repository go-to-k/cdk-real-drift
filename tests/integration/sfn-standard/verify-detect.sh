#!/usr/bin/env bash
# Step Functions detect + revert (real AWS): flip the declared MUTABLE
# TracingConfiguration.Enabled true->false out of band -> check MUST DETECT -> revert
# -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegSfnStandard; NAME=cdkrd-sfn-standard; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
SMARN="$(aws stepfunctions list-state-machines --region "$REGION" --query "stateMachines[?name=='$NAME'].stateMachineArn" --output text)"
[ -n "$SMARN" ] && [ "$SMARN" != "None" ] || fail "no state machine arn"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob tracing true->false ==="
aws stepfunctions update-state-machine --state-machine-arn "$SMARN" --tracing-configuration enabled=false --region "$REGION" >/dev/null || fail inject
sleep 3
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sfn-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Tracing" /tmp/cdkrd-sfn-detect.out || fail "tracing drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws stepfunctions describe-state-machine --state-machine-arn "$SMARN" --region "$REGION" --query 'tracingConfiguration.enabled' --output text)"
[ "$GOT" = "True" ] || fail "tracing not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

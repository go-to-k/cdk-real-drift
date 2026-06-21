#!/usr/bin/env bash
# SNS FIFO Topic detect + revert (real AWS): flip the declared MUTABLE
# ContentBasedDeduplication true->false out of band (set-topic-attributes) -> check
# MUST DETECT -> revert (CC) -> CLEAN + restored. (Revert via Cloud Control.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegSnsFifo; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
TARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text | head -1)"
[ -n "$TARN" ] && [ "$TARN" != "None" ] || fail "no topic arn"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob ContentBasedDeduplication true->false ==="
aws sns set-topic-attributes --topic-arn "$TARN" --attribute-name ContentBasedDeduplication --attribute-value false --region "$REGION" || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-snsfifo-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "ContentBasedDeduplication" /tmp/cdkrd-snsfifo-detect.out || fail "CBD drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws sns get-topic-attributes --topic-arn "$TARN" --region "$REGION" --query 'Attributes.ContentBasedDeduplication' --output text)"
[ "$GOT" = "true" ] || fail "CBD not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

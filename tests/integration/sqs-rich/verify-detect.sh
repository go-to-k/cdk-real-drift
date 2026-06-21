#!/usr/bin/env bash
# SQS Queue detect + revert (real AWS): flip the declared MUTABLE VisibilityTimeout
# 60->120 on the MAIN queue out of band (set-queue-attributes) -> check MUST DETECT ->
# revert (CC) -> CLEAN + restored. (Foundational messaging resource; revert via Cloud
# Control UpdateResource.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegSqsRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
QURL="$(aws sqs list-queues --region "$REGION" --query "QueueUrls[?contains(@,'cdkrd-sqs-rich')]" --output text | tr '\t' '\n' | grep -v dlq | head -1)"
[ -n "$QURL" ] || fail "no main queue url"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob VisibilityTimeout 60->120 ==="
aws sqs set-queue-attributes --queue-url "$QURL" --attributes VisibilityTimeout=120 --region "$REGION" || fail inject
sleep 2
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sqs-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "VisibilityTimeout" /tmp/cdkrd-sqs-detect.out || fail "VisibilityTimeout drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names VisibilityTimeout --region "$REGION" --query 'Attributes.VisibilityTimeout' --output text)"
[ "$GOT" = "60" ] || fail "VisibilityTimeout not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

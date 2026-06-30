#!/usr/bin/env bash
# Standalone SNS Subscription detect + revert (real AWS). Drift the declared MUTABLE
# RawMessageDelivery true->false out of band (the "someone flipped it in the console"
# scenario) -> check MUST DETECT -> revert (Cloud Control SetSubscriptionAttributes)
# -> CLEAN + restored to true.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegSnsSubscriptionRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
export AWS_CLI_AUTO_PROMPT=off
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
TOPIC="$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn,'cdkrd-sub-topic')].TopicArn" --output text)"
[ -n "$TOPIC" ] && [ "$TOPIC" != "None" ] || fail "no topic arn"
SUB="$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --region "$REGION" --query "Subscriptions[0].SubscriptionArn" --output text)"
[ -n "$SUB" ] && [ "$SUB" != "None" ] || fail "no subscription arn"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob RawMessageDelivery true->false ==="
aws sns set-subscription-attributes --subscription-arn "$SUB" --attribute-name RawMessageDelivery --attribute-value false --region "$REGION" || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sns-sub-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "RawMessageDelivery" /tmp/cdkrd-sns-sub-detect.out || fail "drift not reported"
echo "=== revert (Cloud Control SetSubscriptionAttributes) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-sns-sub-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-sns-sub-revert.out || fail "revert did not converge"
GOT="$(aws sns get-subscription-attributes --subscription-arn "$SUB" --region "$REGION" --query 'Attributes.RawMessageDelivery' --output text)"
[ "$GOT" = "true" ] || fail "RawMessageDelivery not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

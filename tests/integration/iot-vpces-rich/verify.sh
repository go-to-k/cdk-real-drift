#!/usr/bin/env bash
# False-positive AND missed-detection integration test (real AWS) for the IoT
# Core family (Thing / Policy / TopicRule) + EC2 VPCEndpointService:
#   1. deploy -> record -> check MUST be CLEAN (FP half).
#   2. disable the topic rule out of band (aws iot disable-topic-rule) ->
#      check MUST detect the declared RuleDisabled drift (exit 1) ->
#      revert -> check CLEAN again and the live rule is re-enabled (FN half).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIotVpces
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
RULE=cdkrd_hunt_rule

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] harvest corpus (pre-record fresh check) ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-/tmp/corpus-iot-vpces}" $CLI check "$STACK" --region "$REGION" || true

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] FN half: disable the topic rule out of band ==="
aws iot disable-topic-rule --rule-name "$RULE" --region "$REGION" || fail "disable-topic-rule"

echo "=== [$STACK] check MUST DETECT the RuleDisabled drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || { echo "--- MISSED DETECTION: out-of-band disable-topic-rule not reported ---"; fail "expected drift (exit 1), got $rc"; }
grep -q "RuleDisabled" "/tmp/cdkrd-$STACK-detect.out" || fail "drift report does not mention RuleDisabled"

echo "=== [$STACK] revert the drift ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "=== [$STACK] live rule MUST be re-enabled ==="
disabled="$(aws iot get-topic-rule --rule-name "$RULE" --region "$REGION" --query 'rule.ruleDisabled' --output text)"
[ "$disabled" = "False" ] || fail "live rule still disabled after revert (ruleDisabled=$disabled)"

echo "INTEG PASS ($STACK)"

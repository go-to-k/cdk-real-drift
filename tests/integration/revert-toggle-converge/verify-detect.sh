#!/usr/bin/env bash
# Detection + REVERT-CONVERGENCE test. For each undeclared, KNOWN_DEFAULTS-folded property
# that is toggled only by a dedicated provider API, mutate it out of band, assert check
# DETECTS, revert, then assert the LIVE value actually returned to the default. The live
# assertion is the point: a revert that merely OMITS the property is a silent no-op (Cloud
# Control reports SUCCESS yet the value persists) unless REVERT_SET_DEFAULT_PATHS writes the
# default explicitly.
set -uo pipefail
export AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevertToggle0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "DETECT FAIL ($STACK): $*"; exit 1; }

echo "=== deploy ==="
npx cdk deploy -f "$STACK" --require-approval never >/dev/null 2>&1 || fail "deploy"

RULE="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Events::Rule'].PhysicalResourceId" --output text)"
STREAM="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Kinesis::Stream'].PhysicalResourceId" --output text)"
[ -n "$RULE" ] && [ -n "$STREAM" ] || fail "could not resolve physical ids"

echo "=== record clean baseline ==="
$CLI record "$STACK" --region "$REGION" --yes >/dev/null 2>&1 || fail "record"
$CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 || fail "expected CLEAN after record"

# --- Events::Rule State ---
echo "=== Events::Rule: disable out of band, detect, revert, assert re-ENABLED ==="
aws events disable-rule --name "$RULE" --region "$REGION" || fail "disable-rule"
$CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 && fail "check did NOT detect DISABLED rule (FN)"
$CLI revert "$STACK" --region "$REGION" --yes 2>&1 | grep -iE "State|revert|Rule" | head
RULE_STATE="$(aws events describe-rule --name "$RULE" --region "$REGION" --query State --output text)"
echo "live Rule State after revert: $RULE_STATE (want ENABLED)"
[ "$RULE_STATE" = "ENABLED" ] || fail "revert did NOT restore Rule State (still $RULE_STATE) — silent no-op"

# --- Kinesis::Stream RetentionPeriodHours ---
echo "=== Kinesis::Stream: increase retention out of band, detect, revert, assert back to 24 ==="
aws kinesis increase-stream-retention-period --stream-name "$STREAM" --retention-period-hours 48 --region "$REGION" || fail "increase-retention"
# Kinesis retention update settles quickly but poll until ACTIVE.
for _ in 1 2 3 4 5 6; do
  st="$(aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" --query StreamDescriptionSummary.StreamStatus --output text)"
  [ "$st" = "ACTIVE" ] && break; sleep 5
done
$CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 && fail "check did NOT detect retention 48 (FN)"
$CLI revert "$STACK" --region "$REGION" --yes 2>&1 | grep -iE "Retention|revert|Stream" | head
for _ in 1 2 3 4 5 6; do
  st="$(aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" --query StreamDescriptionSummary.StreamStatus --output text)"
  [ "$st" = "ACTIVE" ] && break; sleep 5
done
RET="$(aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" --query StreamDescriptionSummary.RetentionPeriodHours --output text)"
echo "live Stream RetentionPeriodHours after revert: $RET (want 24)"
[ "$RET" = "24" ] || fail "revert did NOT restore RetentionPeriodHours (still $RET) — silent no-op"

echo "=== post-revert check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 || fail "expected CLEAN after revert"
echo "DETECT+CONVERGE PASS ($STACK)"

#!/usr/bin/env bash
# cdk-real-drift `added` integ test for EventBridge (the FIFTH CHILD_ENUMERATORS member).
#   deploy fixture (custom EventBus + one declared Rule) -> record -> CLEAN
#   -> put-rule an undeclared rule on the SAME bus out of band -> check reports the rule
#      under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it (proves
#      CC GetResource + normalize for AWS::Events::Rule) -> CLEAN
#   -> add ANOTHER out-of-band rule -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; the rules are removed with the bus.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/eventbus-rule-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEventBusAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # An out-of-band rule we recorded (but did not revert) lingers on the custom bus and
  # BLOCKS the bus's deletion (CFn cannot delete a bus that still has rules) -> the stack
  # goes DELETE_FAILED, and delstack only sees STACK members, not a stack-external rule
  # sitting on a member bus. So sweep any out-of-band rules off the bus FIRST.
  local bus
  bus="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::Events::EventBus'].PhysicalResourceId" \
    --output text 2>/dev/null)"
  if [ -n "$bus" ] && [ "$bus" != "None" ]; then
    for r in $(aws events list-rules --event-bus-name "$bus" --region "$REGION" \
      --query "Rules[?starts_with(Name, 'cdkrd-integ-oob')].Name" --output text 2>/dev/null); do
      aws events delete-rule --name "$r" --event-bus-name "$bus" --region "$REGION" >/dev/null 2>&1 || true
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_rule() { # $1 = rule name -> puts a target-less rule on the bus
  aws events put-rule --name "$1" --event-bus-name "$BUS_NAME" --region "$REGION" \
    --event-pattern '{"source":["cdkrd.integ.oob"]}' >/dev/null || fail "put-rule $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

BUS_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Events::EventBus'].PhysicalResourceId" --output text)"
[ -n "$BUS_NAME" ] || fail "could not resolve EventBus name"

echo "=== put an undeclared rule on the bus out of band ==="
inject_rule cdkrd-integ-oob-record

echo "=== check reports the rule as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-evb.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-evb.out || fail "added rule not under [Not Recorded]"
grep -q "AWS::Events::Rule" /tmp/cdkrd-integ-evb.out || fail "the out-of-band rule not reported"
grep -q "added=" /tmp/cdkrd-integ-evb.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added rule (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for Events::Rule) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-evb-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added rule, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-evb-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band rule for the revert path ==="
inject_rule cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-evb-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-evb-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-evb-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-evb-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second rule must be gone from AWS ==="
if aws events describe-rule --name cdkrd-integ-oob-revert --event-bus-name "$BUS_NAME" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted rule still exists (delete did not take effect)"
fi

echo "INTEG PASS"

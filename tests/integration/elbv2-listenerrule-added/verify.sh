#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Elastic Load Balancing v2 LISTENER RULES (the
# FIFTEENTH CHILD_ENUMERATORS member).
#   deploy fixture (internal ALB + one Listener + one declared ListenerRule) -> record ->
#     CLEAN (the declared priority-10 rule and the auto-created DEFAULT rule must NOT flag)
#   -> create-rule an undeclared rule on the SAME listener out of band ->
#      check reports the rule under [Potential Drift] and is NOT drift (exit 0) ->
#      `record` snapshots it (proves CC GetResource for AWS::ElasticLoadBalancingV2::ListenerRule)
#      -> CLEAN
#   -> add ANOTHER out-of-band rule -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; the rules cascade with the listener/ALB. ALB+VPC teardown is slow
# (~3-5 min) and ENI-orphan-prone, so the trap explicitly verifies the VPC is gone.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/elbv2-listenerrule-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegElbv2ListenerRuleAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting the ALB CASCADES its listeners and their rules, so no out-of-band rule can
  # block the ALB's deletion. delstack tears the stack down.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
  # ENI-orphan check: the VPC must be gone (an internal ALB's ENIs can otherwise block it).
  local vpcs
  vpcs="$(aws ec2 describe-vpcs --region "$REGION" \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null)"
  if [ -n "$vpcs" ]; then
    echo "WARNING: stack VPC(s) still present after teardown: $vpcs"
  else
    echo "teardown verified: no stack VPC remains"
  fi
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_rule() { # $1 = priority, $2 = path -> creates a fixed-response rule; echoes its ARN
  aws elbv2 create-rule --listener-arn "$LISTENER" --priority "$1" \
    --conditions "Field=path-pattern,Values=$2" \
    --actions 'Type=fixed-response,FixedResponseConfig={StatusCode=200,ContentType=text/plain}' \
    --region "$REGION" --query 'Rules[0].RuleArn' --output text || fail "create-rule $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared priority-10 rule + default rule NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2rule-base.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record"
grep -q "Potential Drift" /tmp/cdkrd-integ-elbv2rule-base.out && fail "declared/default rule wrongly flagged" || true

LISTENER="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::Listener'].PhysicalResourceId" --output text)"
[ -n "$LISTENER" ] || fail "could not resolve Listener ARN"

echo "=== create-rule (undeclared) on the listener out of band ==="
ARN1="$(inject_rule 50 '/oob-record')"
[ -n "$ARN1" ] || fail "no ARN for the first out-of-band rule"

echo "=== check reports the rule as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2rule.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-elbv2rule.out || fail "added rule not under [Potential Drift]"
grep -q "AWS::ElasticLoadBalancingV2::ListenerRule" /tmp/cdkrd-integ-elbv2rule.out || fail "the out-of-band rule not reported"
grep -q "added=" /tmp/cdkrd-integ-elbv2rule.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added rule (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the RuleArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2rule-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added rule, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-elbv2rule-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band rule for the revert path ==="
ARN2="$(inject_rule 51 '/oob-revert')"
[ -n "$ARN2" ] || fail "no ARN for the second out-of-band rule"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2rule-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-elbv2rule-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-elbv2rule-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-elbv2rule-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second rule (priority 51) must be gone from AWS ==="
LEFT="$(aws elbv2 describe-rules --listener-arn "$LISTENER" --region "$REGION" \
  --query "Rules[?Priority=='51']" --output text 2>/dev/null)"
[ -z "$LEFT" ] || fail "the reverted rule still exists (delete did not take effect)"

echo "INTEG PASS"

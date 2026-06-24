#!/usr/bin/env bash
# False-positive + read-gap integration test (real AWS): deploy -> record baseline ->
# check MUST be CLEAN. AWS::CodeDeploy::DeploymentGroup's CFn Ref is the bare
# DeploymentGroupName, but Cloud Control's primaryIdentifier is the composite
# [ApplicationName, DeploymentGroupName]; the CC_IDENTIFIER_ADAPTERS entry must pair
# them (parent-first) or the group is silently `skipped` (read-gap). A surviving
# declared drift on a clean recorded stack is a set-like-reorder normalization FP
# (TriggerEvents / AutoRollbackConfiguration.Events / Alarms).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodeDeployDeploymentGroupReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] check BEFORE record (read-gap probe — group must NOT be skipped) ==="
$CLI check "$STACK" --region "$REGION" --verbose | tee "/tmp/cdkrd-$STACK.pre"
grep -qi "skipped" "/tmp/cdkrd-$STACK.pre" && echo "WARN: a resource was skipped (possible read-gap) — inspect above"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

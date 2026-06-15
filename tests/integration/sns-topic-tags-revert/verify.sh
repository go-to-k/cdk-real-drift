#!/usr/bin/env bash
# cdkrd REVERT integration test (real AWS, AWS-mutating) — aws:* managed-tag
# preservation. Reproduces the live bug: reverting an out-of-band USER tag on an
# SNS Topic must NOT try to drop the aws:cloudformation:* managed tags (AWS rejects
# "aws: prefixed tag key names are not allowed for external use").
#   deploy -> record (baseline; topic has only aws:* managed tags) -> check CLEAN
#   -> add a USER tag out of band -> check DETECTS undeclared Tags drift
#   -> revert --yes (must SUCCEED) -> check CLEAN
#   -> assert AWS: user tag gone, aws:cloudformation:* tags STILL present -> destroy.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSnsTagsRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== install fixture deps ==="; [ -d node_modules ] || npm install >/dev/null 2>&1 || fail "npm install"
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)"
[ -n "$ARN" ] || fail "no topic physical id"
echo "topic: $ARN"

echo "=== record baseline (topic has only aws:* managed tags -> zero user Tags, snapshot-complete) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"

echo "=== add a USER tag out of band ==="
aws sns tag-resource --resource-arn "$ARN" --tags Key=TestAddedTag,Value=TestAddedTagAAA --region "$REGION" || fail "tag-resource"
sleep 5

echo "=== check DETECTS the undeclared Tags drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-snstags-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "Tags" /tmp/cdkrd-snstags-pre.out || fail "undeclared Tags drift not reported"
grep -q "TestAddedTag" /tmp/cdkrd-snstags-pre.out || fail "the added user tag not reported"

echo "=== revert --yes (writes to AWS via Cloud Control; MUST succeed past the aws:* tag restriction) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-snstags-revert.out || fail "revert returned non-zero"
grep -qi "aws: prefixed tag key names" /tmp/cdkrd-snstags-revert.out && fail "revert hit the aws:* managed-tag rejection (the bug is NOT fixed)"
grep -qi "FAILED" /tmp/cdkrd-snstags-revert.out && fail "revert reported a FAILED op"

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert"

echo "=== assert AWS converged: user tag GONE, aws:cloudformation:* tags PRESERVED ==="
TAGS_JSON="$(aws sns list-tags-for-resource --resource-arn "$ARN" --region "$REGION" --query 'Tags' --output json)"
echo "$TAGS_JSON"
echo "$TAGS_JSON" | grep -q "TestAddedTag" && fail "user tag still present after revert (not removed)"
echo "$TAGS_JSON" | grep -q "aws:cloudformation:stack-name" || fail "aws:cloudformation:* managed tags were destroyed by the revert"

echo "INTEG PASS"

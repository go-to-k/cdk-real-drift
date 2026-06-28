#!/usr/bin/env bash
# cdk-real-drift map-shaped-Tags revert integration test (real AWS).
#
# An AWS::SSM::Parameter carries MAP-shaped Tags (key->value object). cdkrd surfaces an
# out-of-band tag key as a nested `Tags.<key>` undeclared drift; this verifies the revert
# of such a key WORKS — a single-key `remove /Tags/<key>` Cloud Control applies while
# leaving the aws:cloudformation:* managed tags (and the declared tag) untouched.
#
# Flow: deploy -> record CLEAN baseline -> check CLEAN -> add out-of-band tag (rogueKey)
#   -> check DETECTS `Tags.rogueKey` -> revert -> re-read tags: rogueKey GONE, declaredKey
#   + aws:* PRESERVED.
# A cleanup trap force-deletes the stack and removes the baseline even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/ssm-maptag-revert && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSsmMapTag
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

PNAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId" --output text)"
[ -n "$PNAME" ] || fail "could not resolve parameter physical id"

echo "=== record CLEAN baseline + check CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== add out-of-band tag rogueKey ==="
aws ssm add-tags-to-resource --resource-type Parameter --resource-id "$PNAME" \
  --tags Key=rogueKey,Value=rogueVal --region "$REGION" || fail "inject tag"

echo "=== check should DETECT Tags.rogueKey ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ssmtag.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Tags.rogueKey" /tmp/cdkrd-integ-ssmtag.out || fail "Tags.rogueKey not reported"

echo "=== revert (removes the out-of-band tag key) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-integ-ssmtag-revert.out \
  || fail "revert command errored"

echo "=== verify convergence on live tags ==="
TAGS_AFTER="$(aws ssm list-tags-for-resource --resource-type Parameter --resource-id "$PNAME" \
  --region "$REGION" --query 'TagList' --output json | tr -d ' \n')"
echo "tags after revert: $TAGS_AFTER"
echo "$TAGS_AFTER" | grep -q "rogueKey" && fail "rogueKey NOT removed by revert"
echo "$TAGS_AFTER" | grep -q "declaredKey" || fail "declared tag wrongly removed"
echo "$TAGS_AFTER" | grep -q "aws:cloudformation:" || fail "aws:* managed tags wrongly removed"

echo "INTEG PASS"

#!/usr/bin/env bash
# cdkrd REMOVED-SINCE-RECORD REVERT integration test (real AWS, AWS-mutating).
# Proves a recorded UNDECLARED value that DISAPPEARS out of band can be RESTORED by
# `revert` — previously it failed with "no physical id" (the synthesized
# "baseline value removed since record" finding carried no physical id).
# Flow: deploy an S3 bucket (no website config declared) -> set an undeclared
# WebsiteConfiguration out of band -> record (baseline now has it) -> check CLEAN ->
# DELETE the website config out of band -> check DETECTS "baseline value removed since
# record" (exit 1) -> revert --yes (re-adds it) -> check CLEAN -> direct AWS read
# confirms the website config is back -> destroy.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRevertRemoved
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp pack) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "could not resolve bucket name"

echo "=== set an undeclared WebsiteConfiguration out of band ==="
aws s3api put-bucket-website --bucket "$BUCKET" --region "$REGION" \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"}}' || fail "put-bucket-website"
sleep 5

echo "=== record (baseline captures the undeclared website config) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record

echo "=== check CLEAN (the website config is now recorded) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-rr-clean.out
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "=== DELETE the website config out of band ==="
aws s3api delete-bucket-website --bucket "$BUCKET" --region "$REGION" || fail "delete-bucket-website"
sleep 5

echo "=== check DETECTS the removed-since-record value (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-rr-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1 after website-config removal"
grep -q "removed since record" /tmp/cdkrd-rr-pre.out || fail "removed-since-record not reported"

echo "=== revert --yes (must restore the config — NOT 'no physical id') ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-rr-revert.out || fail "revert returned non-zero"
grep -qi "no physical id" /tmp/cdkrd-rr-revert.out && fail "revert still says 'no physical id' (the bug)"
sleep 5

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert"

echo "=== belt-and-suspenders: the website config is back on the bucket ==="
SUFFIX="$(aws s3api get-bucket-website --bucket "$BUCKET" --region "$REGION" \
  --query 'IndexDocument.Suffix' --output text 2>/dev/null)"
echo "live IndexDocument.Suffix: '$SUFFIX'"
[ "$SUFFIX" = "index.html" ] || fail "website config not restored by revert (got '$SUFFIX')"

echo "INTEG PASS (CdkRealDriftIntegRevertRemoved removed-since-record revert restores the value)"

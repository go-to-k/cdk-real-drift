#!/usr/bin/env bash
# cdk-real-drift tag-addition mutation integration test (real AWS, R95).
# Guards the R95 fix: a console-ADDED tag (a Key the template never declared) must be
# DETECTED, not silently dropped by subset projection. Deploy a bucket with one
# declared tag, record CLEAN, add a second tag out of band, assert check detects it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegMutationTags; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }
echo "=== build + deploy + record ==="
(cd "$ROOT" && vp run build) || fail "build"
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"
echo "=== add a tag out of band (a Key the template never declared) ==="
B="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$B" ] || fail "no bucket"
# ADD a tag without disturbing existing tags (the Resource Groups Tagging API
# appends; put-bucket-tagging would REPLACE all tags and then refuse to drop the
# aws:cloudformation:* system tags).
aws resourcegroupstaggingapi tag-resources --resource-arn-list "arn:aws:s3:::$B" \
  --tags rogue=injected --region "$REGION" || fail "add tag"
sleep 5
echo "=== check must DETECT the added tag (R95: not subset-projected away) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mut-tags.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 — the added tag was MISSED (the R95 bug)"
grep -qi "Tags\|rogue" /tmp/cdkrd-mut-tags.out || fail "the added tag was not named in the report"
echo "INTEG PASS"

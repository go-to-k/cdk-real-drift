#!/usr/bin/env bash
# cdkrd CloudFront legacy OAI integration test (real AWS, read-only mutation of an
# S3 bucket policy out of band). Reproduces — and pins the fix for — the S3
# BucketPolicy principal-form false positive (ported concern from cdkd #871):
#   declared (CDK grantRead(oai)):  Principal = { CanonicalUser: <S3CanonicalUserId> }
#   live (GetBucketPolicy returns): Principal = { AWS: "arn:aws:iam::cloudfront:user/
#                                                  CloudFront Origin Access Identity <oaiId>" }
# The two are equivalent; before the fix cdkrd reported a false declared drift on
# the bucket policy. The fix resolves the OAI id -> S3CanonicalUserId from the
# stack's own OAI resource and reconciles the two principal forms.
#
# Flow: deploy -> check (bucket policy CLEAN, no false declared drift) -> repoint the
# bucket policy to a DIFFERENT (fictional) OAI principal out of band -> check DETECTS
# a declared drift on the policy (the fix does NOT blanket-suppress) -> destroy.
# Self-cleaning trap; no orphans on failure. No Distribution → fast deploy.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegCloudfrontOai
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "could not resolve bucket"

echo "=== check CLEAN (no false declared drift on the OAI bucket policy) ==="
$CLI check "$STACK" --region "$REGION" --json > /tmp/cdkrd-oai-clean.json 2>/tmp/cdkrd-oai-clean.err \
  || { cat /tmp/cdkrd-oai-clean.err; fail "check errored"; }
node -e '
  const j = require("/tmp/cdkrd-oai-clean.json");
  const bad = (j.findings||[]).filter(f =>
    f.resourceType === "AWS::S3::BucketPolicy" &&
    (f.tier === "declared" || f.tier === "undeclared"));
  if (bad.length) { console.error("UNEXPECTED bucket-policy drift:\n"+JSON.stringify(bad,null,2)); process.exit(1); }
  console.log("bucket policy clean ✓");
' || fail "false positive on the OAI bucket policy (the bug this fixes)"

echo "=== inject a real out-of-band statement, KEEPING the OAI grant ==="
# S3 rejects a fictional cloudfront:user principal (MalformedPolicy), so we cannot
# repoint to a fake OAI. Instead append a second, valid statement to the LIVE policy
# (which still carries the genuine OAI grant). The OAI statement reconciles to clean;
# the appended one must surface — proving the fix does NOT blanket-suppress the policy.
DOC="$(aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" --query Policy --output text)"
aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy "$(node -e '
  const doc = JSON.parse(process.argv[1]);
  doc.Statement.push({ Sid: "CdkrdInjected", Effect: "Deny", Principal: "*",
    Action: "s3:GetBucketTagging", Resource: "arn:aws:s3:::'"$BUCKET"'" });
  process.stdout.write(JSON.stringify(doc));
' "$DOC")" || fail "could not inject extra statement"
sleep 3

echo "=== check DETECTS the injected statement (no blanket suppression) ==="
$CLI check "$STACK" --region "$REGION" --json > /tmp/cdkrd-oai-drift.json 2>/dev/null
node -e '
  const j = require("/tmp/cdkrd-oai-drift.json");
  const hit = (j.findings||[]).some(f => f.resourceType === "AWS::S3::BucketPolicy");
  if (!hit) { console.error("injected bucket-policy statement was NOT detected"); process.exit(1); }
  console.log("injected statement detected ✓");
' || fail "out-of-band bucket-policy change was not reported"

echo "INTEG PASS"

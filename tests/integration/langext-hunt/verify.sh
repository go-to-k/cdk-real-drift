#!/usr/bin/env bash
# LanguageExtensions live probe: deploy the raw-CFn template (Transform:
# AWS::LanguageExtensions with Fn::ForEach + Fn::ToJsonString), hand-build a
# minimal cdk.out pointing at the ORIGINAL (unexpanded) template, and assert
# cdkrd's #904 Processed-template fallback makes the first check CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0721LangExt
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack -s "$STACK" -r "$REGION" -y -f >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (langext-hunt): $*"; exit 1; }

echo "=== deploy (raw CloudFormation) ==="
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file template.yaml || fail "deploy"

echo "=== hand-build cdk.out (template.json is the committed JSON twin of template.yaml) ==="
rm -rf cdk.out && mkdir -p cdk.out
cp template.json cdk.out/template.json || fail "template to json"
cat > cdk.out/manifest.json <<EOF
{
  "version": "36.0.0",
  "artifacts": {
    "$STACK": {
      "type": "aws:cloudformation:stack",
      "environment": "aws://unknown-account/$REGION",
      "properties": { "templateFile": "template.json", "stackName": "$STACK" }
    }
  }
}
EOF

echo "=== FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-langext}" $CLI check "$STACK" --app cdk.out --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC)"

echo "=== record + check --fail ==="
$CLI record "$STACK" --app cdk.out --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --app cdk.out --region "$REGION" --fail || fail "post-record check not clean"

echo "INTEG OK (langext-hunt)"

#!/usr/bin/env bash
# False-positive integration test (real AWS): barest ELBv2 TrustStore — the only
# SDK_SUPPLEMENTS entry that had zero fixture/corpus coverage. The supplement
# synthesizes the CaCertificatesBundleSha256 integrity signal (#505), which is a
# DESIGNED undeclared first-run surface (the same shape as Lambda CodeSha256), so
# the pre-record check must show EXACTLY that one potential-drift entry and
# nothing else; record -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713TrustStore
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CA_BUCKET="${CA_BUNDLE_BUCKET:-cdkrd-hunt-ca-$RANDOM$RANDOM}"
CA_KEY="${CA_BUNDLE_KEY:-cdkrd-hunt-ca.pem}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  aws s3 rb "s3://$CA_BUCKET" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out ca.key ca.pem
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] pre-step: CA bundle bucket ==="
if ! aws s3api head-bucket --bucket "$CA_BUCKET" >/dev/null 2>&1; then
  aws s3 mb "s3://$CA_BUCKET" --region "$REGION" || fail "mb"
  aws s3api put-bucket-tagging --bucket "$CA_BUCKET" --tagging 'TagSet=[{Key=cdkrd:ephemeral,Value=1}]' || true
fi
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 7 -subj "/CN=cdkrd-hunt-ca" 2>/dev/null || fail "openssl"
aws s3 cp ca.pem "s3://$CA_BUCKET/$CA_KEY" --region "$REGION" >/dev/null || fail "upload"

echo "=== [$STACK] deploy fixture ==="
CA_BUNDLE_BUCKET="$CA_BUCKET" CA_BUNDLE_KEY="$CA_KEY" npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): only the designed Sha256 signal may surface ==="
CA_BUNDLE_BUCKET="$CA_BUCKET" CA_BUNDLE_KEY="$CA_KEY" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "CaCertificatesBundleSha256" "/tmp/cdkrd-$STACK.first.out" || fail "expected the CA-bundle Sha256 integrity signal (supplement not running?)"
grep -q "Potential Drift: 1" "/tmp/cdkrd-$STACK.first.out" || fail "expected EXACTLY one potential-drift entry (new fold gap?)"
grep -q "Declared Drift" "/tmp/cdkrd-$STACK.first.out" && fail "declared drift on a clean deploy"

echo "=== [$STACK] record (write baseline) ==="
CA_BUNDLE_BUCKET="$CA_BUCKET" CA_BUNDLE_KEY="$CA_KEY" $CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
CA_BUNDLE_BUCKET="$CA_BUCKET" CA_BUNDLE_KEY="$CA_KEY" $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

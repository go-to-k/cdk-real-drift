#!/usr/bin/env bash
# ELBv2 pack first-run FP probe (real AWS). Pre-creates a self-signed ACM cert
# (imported) + the TrustStore CA-bundle bucket out of band, deploys, asserts the
# FIRST check is CLEAN (modulo the BY-DESIGN TrustStore CaCertificatesBundleSha256
# integrity signal, #505), records, asserts clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0801Elb
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCT="$(aws sts get-caller-identity --query Account --output text)"
export CDKRD_HUNT_TS_BUCKET="cdkrd-hunt0801-elb-ts-$ACCT"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  aws s3 rb "s3://$CDKRD_HUNT_TS_BUCKET" --force >/dev/null 2>&1 || true
  if [ -n "${CDKRD_HUNT_CERT_ARN:-}" ]; then
    for i in 1 2 3 4 5 6; do
      aws acm delete-certificate --certificate-arn "$CDKRD_HUNT_CERT_ARN" --region "$REGION" >/dev/null 2>&1 && break
      sleep 20
    done
  fi
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== pre-create self-signed cert (ACM import) + CA bundle bucket ==="
openssl req -x509 -newkey rsa:2048 -keyout /tmp/cdkrd-elb-key.pem -out /tmp/cdkrd-elb-cert.pem \
  -days 7 -nodes -subj "/CN=cdkrd-hunt0801-elb.internal" 2>/dev/null || fail "openssl"
CDKRD_HUNT_CERT_ARN=$(aws acm import-certificate --certificate fileb:///tmp/cdkrd-elb-cert.pem \
  --private-key fileb:///tmp/cdkrd-elb-key.pem --region "$REGION" \
  --tags Key=cdkrd:ephemeral,Value=1 --query CertificateArn --output text) || fail "acm import"
export CDKRD_HUNT_CERT_ARN
openssl req -x509 -newkey rsa:2048 -keyout /tmp/cdkrd-elb-ca-key.pem -out /tmp/cdkrd-elb-ca.pem \
  -days 7 -nodes -subj "/CN=cdkrd-hunt0801-mtls-ca.internal" 2>/dev/null || fail "openssl ca"
aws s3api create-bucket --bucket "$CDKRD_HUNT_TS_BUCKET" --region "$REGION" >/dev/null || true
aws s3 cp /tmp/cdkrd-elb-ca.pem "s3://$CDKRD_HUNT_TS_BUCKET/ca-bundle.pem" >/dev/null || fail "s3 cp"

echo "=== deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== FIRST check (no baseline): only the TrustStore sha256 signal may appear ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-elbpack0801}" $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
# Count the drift ENTRY lines (indented `<id>.<path> (AWS::...)`) inside the block, not the
# block header; the only allowed entry is the by-design TrustStore sha256 signal (#505).
NON_SHA=$(sed -n '/\[Potential Drift/,/^──/p' "/tmp/cdkrd-$STACK.pre.out" \
  | grep -E '^\s+\S+ \(AWS::' | grep -vc "CaCertificatesBundleSha256" || true)
[ "$NON_SHA" -eq 0 ] || fail "first check surfaced $NON_SHA non-sha256 potential drift entries"

echo "=== record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "INTEG OK (elbpack-hunt)"

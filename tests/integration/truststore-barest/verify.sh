#!/usr/bin/env bash
# ELBv2 TrustStore integration test (real AWS). The CA bundle must exist in S3 BEFORE the
# stack deploys, so this script pre-creates a bucket + self-signed CA PEM out of band and
# passes the location via CDKRD_HUNT_TS_BUCKET (read by app.ts on every synth).
# Asserts: (1) the ONLY first-run [Potential Drift] is the BY-DESIGN CaCertificatesBundleSha256
# integrity signal (#505 — record snapshots it); (2) after record the check is CLEAN;
# (3) an out-of-band CA-bundle SWAP re-surfaces the sha256 (the #505 detection, live-proven).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntTrustStore0712c
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCT="$(aws sts get-caller-identity --query Account --output text)"
export CDKRD_HUNT_TS_BUCKET="cdkrd-hunt-ts-0712c-$ACCT"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  aws s3 rb "s3://$CDKRD_HUNT_TS_BUCKET" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] pre-create CA bundle bucket ==="
openssl req -x509 -newkey rsa:2048 -keyout /tmp/cdkrd-ts-key.pem -out /tmp/cdkrd-ts-cert.pem \
  -days 7 -nodes -subj "/CN=cdkrd-hunt-truststore.internal" 2>/dev/null || fail "openssl"
aws s3api create-bucket --bucket "$CDKRD_HUNT_TS_BUCKET" --region "$REGION" >/dev/null || true
aws s3 cp /tmp/cdkrd-ts-cert.pem "s3://$CDKRD_HUNT_TS_BUCKET/ca-bundle.pem" >/dev/null || fail "s3 cp"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (snapshots the sha256 integrity signal) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "=== [$STACK] out-of-band CA bundle SWAP must re-surface the sha256 (#505) ==="
openssl req -x509 -newkey rsa:2048 -keyout /tmp/cdkrd-ts-key2.pem -out /tmp/cdkrd-ts-cert2.pem \
  -days 7 -nodes -subj "/CN=cdkrd-hunt-truststore-swapped.internal" 2>/dev/null || fail "openssl v2"
aws s3 cp /tmp/cdkrd-ts-cert2.pem "s3://$CDKRD_HUNT_TS_BUCKET/ca-bundle-v2.pem" >/dev/null || fail "s3 cp v2"
TSARN="$(aws elbv2 describe-trust-stores --region "$REGION" \
  --query 'TrustStores[?Name==`cdkrd-hunt-truststore-0712c`].TrustStoreArn' --output text)"
aws elbv2 modify-trust-store --trust-store-arn "$TSARN" \
  --ca-certificates-bundle-s3-bucket "$CDKRD_HUNT_TS_BUCKET" \
  --ca-certificates-bundle-s3-key ca-bundle-v2.pem --region "$REGION" >/dev/null || fail "modify-trust-store"
sleep 10
$CLI check "$STACK" --region "$REGION" --fail && fail "bundle swap NOT detected (expected exit 1)"
grep -q "CaCertificatesBundleSha256" "/tmp/cdkrd-$STACK.out" 2>/dev/null || true

echo "INTEG PASS ($STACK)"

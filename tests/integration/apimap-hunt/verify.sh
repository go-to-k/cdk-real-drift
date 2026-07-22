#!/usr/bin/env bash
# ApiGatewayV2 ApiMapping + ApiGateway BasePathMapping adapter probe: import a
# self-signed cert to ACM out of band (regional API GW domains accept imported
# certs; no DNS involved), deploy both mapping shapes, first check MUST be
# CLEAN with zero skipped reads.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722ApiMap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CERT_ARN=""

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  if [ -n "$CERT_ARN" ]; then
    for _ in 1 2 3 4 5 6; do
      aws acm delete-certificate --certificate-arn "$CERT_ARN" --region "$REGION" >/dev/null 2>&1 && break
      sleep 20
    done
  fi
  rm -rf .cdkrd cdk.out /tmp/cdkrd-apimap-cert
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] out-of-band prep: self-signed cert -> ACM import ==="
mkdir -p /tmp/cdkrd-apimap-cert
openssl req -x509 -newkey rsa:2048 -sha256 -days 3 -nodes \
  -keyout /tmp/cdkrd-apimap-cert/key.pem -out /tmp/cdkrd-apimap-cert/cert.pem \
  -subj "/CN=cdkrd-hunt.example.com" \
  -addext "subjectAltName=DNS:hunt0722-v1.cdkrd-hunt.example.com,DNS:hunt0722-v2.cdkrd-hunt.example.com" \
  >/dev/null 2>&1 || fail "openssl"
CERT_ARN="$(aws acm import-certificate \
  --certificate fileb:///tmp/cdkrd-apimap-cert/cert.pem \
  --private-key fileb:///tmp/cdkrd-apimap-cert/key.pem \
  --tags Key=cdkrd:ephemeral,Value=1 \
  --region "$REGION" --query CertificateArn --output text)" || fail "acm import"
export CERT_ARN
echo "imported: $CERT_ARN"

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN + zero skipped ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-apimap}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"
grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out" && fail "resources skipped (composite-identifier read gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "INTEG PASS ($STACK)"

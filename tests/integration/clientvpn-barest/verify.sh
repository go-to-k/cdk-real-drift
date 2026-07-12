#!/usr/bin/env bash
# False-positive integration test (real AWS): the server certificate must exist in ACM
# BEFORE the stack deploys, so this script imports a self-signed cert out of band and
# passes its ARN via CDKRD_HUNT_VPN_CERT_ARN (read by app.ts on every synth).
# A clean barest endpoint must FIRST-check CLEAN (VpnPort/TransportProtocol/
# SessionTimeoutHours/DisconnectOnSessionTimeout all fold, #554/#1102) and stay CLEAN
# after record. The #1530 off-flip detection lives in verify-detect.sh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntClientVpn0712c
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  # The imported ACM cert is stack-external — delete it after the endpoint is gone.
  [ -n "${CDKRD_HUNT_VPN_CERT_ARN:-}" ] &&
    aws acm delete-certificate --certificate-arn "$CDKRD_HUNT_VPN_CERT_ARN" --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] import self-signed server cert into ACM ==="
openssl req -x509 -newkey rsa:2048 -keyout /tmp/cdkrd-vpn-key.pem -out /tmp/cdkrd-vpn-cert.pem \
  -days 7 -nodes -subj "/CN=cdkrd-hunt-clientvpn.internal" 2>/dev/null || fail "openssl"
CDKRD_HUNT_VPN_CERT_ARN="$(aws acm import-certificate --certificate fileb:///tmp/cdkrd-vpn-cert.pem \
  --private-key fileb:///tmp/cdkrd-vpn-key.pem --region "$REGION" \
  --tags Key=cdkrd:ephemeral,Value=1 --query CertificateArn --output text)" || fail "acm import"
export CDKRD_HUNT_VPN_CERT_ARN

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

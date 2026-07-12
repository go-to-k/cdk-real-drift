#!/usr/bin/env bash
# Missed-detection (FN) integration test for #1530 (real AWS): an out-of-band
# `modify-client-vpn-endpoint --no-disconnect-on-session-timeout` flips a true-pinned
# KNOWN_DEFAULTS boolean OFF. Without the MEANINGFUL_WHEN_OFF pairing the false was
# swallowed by isTrivialEmpty and check stayed CLEAN (live-proven on 0.13.10).
# Sequence: deploy -> first check CLEAN -> record -> OOB flip -> check MUST exit 1 ->
# revert (REVERT_SET_DEFAULT_PATHS writes true back) -> check CLEAN -> live value true.
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

echo "=== [$STACK] deploy + record ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
$CLI check "$STACK" --region "$REGION" --fail || fail "first check not CLEAN"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

VPNID="$(aws ec2 describe-client-vpn-endpoints --region "$REGION" \
  --query 'ClientVpnEndpoints[?Status.Code!=`deleted`]|[0].ClientVpnEndpointId' --output text)"
[ -n "$VPNID" ] && [ "$VPNID" != "None" ] || fail "endpoint id not found"

echo "=== [$STACK] out-of-band disable DisconnectOnSessionTimeout ==="
aws ec2 modify-client-vpn-endpoint --client-vpn-endpoint-id "$VPNID" --region "$REGION" \
  --no-disconnect-on-session-timeout >/dev/null || fail "modify"
sleep 5

echo "=== [$STACK] check MUST detect the off-flip (#1530) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "off-flip NOT detected (the #1530 FN)"
grep -q "DisconnectOnSessionTimeout" "/tmp/cdkrd-$STACK-detect.out" || fail "wrong drift path"

echo "=== [$STACK] revert MUST write true back and converge ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
LIVE="$(aws ec2 describe-client-vpn-endpoints --client-vpn-endpoint-ids "$VPNID" --region "$REGION" \
  --query 'ClientVpnEndpoints[0].DisconnectOnSessionTimeout' --output text)"
[ "$LIVE" = "True" ] || fail "live value not restored (got $LIVE)"
$CLI check "$STACK" --region "$REGION" --fail || fail "not CLEAN after revert"

echo "INTEG PASS ($STACK detect/revert)"

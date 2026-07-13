#!/usr/bin/env bash
# False-positive integration test (real AWS) for the #1560 ListenerCertificate reader.
# Two self-signed certs are imported into ACM out of band BEFORE deploy (no ACM DNS
# validation wait): one is the listener's DEFAULT cert, the other is attached as an SNI
# ListenerCertificate. A clean barest deploy must FIRST-check CLEAN (the reader projects
# only this resource's declared cert from the live NON-default set, excluding the default
# cert) and stay CLEAN after record. The removed-cert FN lives in verify-detect.sh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntListenerCert0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  [ -n "${CDKRD_HUNT_DEFAULT_CERT_ARN:-}" ] &&
    aws acm delete-certificate --certificate-arn "$CDKRD_HUNT_DEFAULT_CERT_ARN" --region "$REGION" >/dev/null 2>&1 || true
  [ -n "${CDKRD_HUNT_SNI_CERT_ARN:-}" ] &&
    aws acm delete-certificate --certificate-arn "$CDKRD_HUNT_SNI_CERT_ARN" --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

import_cert() { # $1=CN → prints ARN
  local cn="$1" key crt
  key="$(mktemp)"; crt="$(mktemp)"
  openssl req -x509 -newkey rsa:2048 -keyout "$key" -out "$crt" -days 7 -nodes -subj "/CN=$cn" 2>/dev/null || return 1
  aws acm import-certificate --certificate "fileb://$crt" --private-key "fileb://$key" --region "$REGION" \
    --tags Key=cdkrd:ephemeral,Value=1 --query CertificateArn --output text
  rm -f "$key" "$crt"
}

echo "=== [$STACK] import two self-signed certs into ACM ==="
CDKRD_HUNT_DEFAULT_CERT_ARN="$(import_cert cdkrd-hunt-default.internal)" || fail "acm import default"
CDKRD_HUNT_SNI_CERT_ARN="$(import_cert cdkrd-hunt-sni.internal)" || fail "acm import sni"
export CDKRD_HUNT_DEFAULT_CERT_ARN CDKRD_HUNT_SNI_CERT_ARN
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION="$REGION"

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

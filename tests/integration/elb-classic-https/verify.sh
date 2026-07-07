#!/usr/bin/env bash
# False-positive integration test (real AWS): an internet-facing classic ELB with an
# HTTPS listener. Uploads a self-signed IAM server certificate (deleted on cleanup),
# then a FIRST `check` BEFORE `record` MUST be CLEAN (core invariant), and record ->
# check MUST also be CLEAN. Exercises AWS's auto-assigned SSL negotiation Policies.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElbClassicHttps; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
CERTNAME=cdkrd-elb-https-hunt
cleanup(){
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -c certArn="$CERTARN" -f -y >/dev/null 2>&1 || true
  aws iam delete-server-certificate --server-certificate-name "$CERTNAME" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== upload self-signed IAM server certificate ==="
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /tmp/elbhttps.key -out /tmp/elbhttps.crt \
  -subj "/CN=cdkrd-elb-https-test.example.com" 2>/dev/null || fail gen-cert
CERTARN=$(aws iam upload-server-certificate --server-certificate-name "$CERTNAME" \
  --certificate-body file:///tmp/elbhttps.crt --private-key file:///tmp/elbhttps.key \
  --query 'ServerCertificateMetadata.Arn' --output text 2>/dev/null) \
  || CERTARN=$(aws iam get-server-certificate --server-certificate-name "$CERTNAME" \
       --query 'ServerCertificate.ServerCertificateMetadata.Arn' --output text)
[ -n "$CERTARN" ] || fail cert-arn
sleep 8 # let IAM propagate the cert before ELB references it

echo "=== deploy ==="; npx cdk deploy -f "$STACK" -c certArn="$CERTARN" --require-approval never || fail deploy
echo "=== first check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" -c certArn="$CERTARN" --fail
rc=$?; [ "$rc" -eq 0 ] || fail "expected first-check CLEAN got $rc"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" -c certArn="$CERTARN" --yes || fail record
echo "=== check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" -c certArn="$CERTARN" --fail
rc=$?; [ "$rc" -eq 0 ] || fail "expected CLEAN got $rc"
echo "INTEG PASS ($STACK)"

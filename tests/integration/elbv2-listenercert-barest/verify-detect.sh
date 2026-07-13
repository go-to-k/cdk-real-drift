#!/usr/bin/env bash
# Detection (FN) integration test for the #1560 ListenerCertificate reader: after a clean
# record, REMOVE the declared SNI cert from the listener out of band. The reader's
# declared∩live projection must then drop it → check DETECTS declared drift (exit 1).
# ListenerCertificate has no SDK writer, so revert is not exercised; the cert is
# re-attached manually to restore before cleanup. Deploy is assumed already done by
# verify.sh in the same run (this reuses the deployed stack + cdk.out + certs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntListenerCert0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
fail() { echo "DETECT FAIL ($STACK): $*"; exit 1; }

: "${CDKRD_HUNT_SNI_CERT_ARN:?set CDKRD_HUNT_SNI_CERT_ARN (the attached SNI cert arn)}"

# Resolve the listener arn from the deployed stack.
LISTENER_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::Listener'].PhysicalResourceId" \
  --output text)"
[ -n "$LISTENER_ARN" ] || fail "could not resolve listener arn"

echo "=== [$STACK] record clean baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] remove SNI cert out of band ==="
aws elbv2 remove-listener-certificates --listener-arn "$LISTENER_ARN" \
  --certificates CertificateArn="$CDKRD_HUNT_SNI_CERT_ARN" --region "$REGION" || fail "remove-listener-certificates"

echo "=== [$STACK] check MUST DETECT the removed cert (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
RC="${PIPESTATUS[0]}"

echo "=== restore SNI cert ==="
aws elbv2 add-listener-certificates --listener-arn "$LISTENER_ARN" \
  --certificates CertificateArn="$CDKRD_HUNT_SNI_CERT_ARN" --region "$REGION" || true

[ "$RC" -eq 1 ] || fail "check did NOT detect the removed SNI cert (FN)"
echo "DETECT PASS ($STACK)"

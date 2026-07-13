#!/usr/bin/env bash
# Detect+revert integration test (real AWS) for a CFn-managed AWS Config recorder (#1553).
# Deploy -> record -> broaden the recorder's recordingGroup.resourceTypes out of band
# (someone widens what Config records) -> check MUST DETECT the declared drift ->
# revert MUST restore ["AWS::S3::Bucket"] via the PutConfigurationRecorder SDK writer
# (Cloud Control cannot write this type: UnsupportedActionException) -> check MUST be CLEAN.
#
# recordingGroup is a declared, mutable property; a live put-configuration-recorder
# change is exactly the divergence cdkrd should catch. Singleton pre-check + capped
# deploy as in verify.sh.
set -uo pipefail
export AWS_CLI_AUTO_PROMPT=off
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegConfigRecorder
REGION="${AWS_REGION:-us-west-2}"
CLI="node $ROOT/dist/cli.js"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-1500}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  aws cloudformation cancel-update-stack --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 \
    || aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out /tmp/cdkrd-recorder-*.json
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] singleton pre-check (region $REGION) ==="
rec="$(aws configservice describe-configuration-recorders --region "$REGION" --query 'ConfigurationRecorders[].name' --output text 2>/dev/null)"
chan="$(aws configservice describe-delivery-channels --region "$REGION" --query 'DeliveryChannels[].name' --output text 2>/dev/null)"
if [ -n "$rec" ] || [ -n "$chan" ]; then
  fail "region $REGION already has a Config recorder [$rec] / channel [$chan] — aborting (singletons)."
fi

echo "=== [$STACK] deploy fixture (cap ${DEPLOY_TIMEOUT}s) ==="
timeout "$DEPLOY_TIMEOUT" npx cdk deploy -f "$STACK" --require-approval never
rc=$?
[ "$rc" -eq 124 ] && fail "deploy exceeded ${DEPLOY_TIMEOUT}s — recorder CC handler likely hung (#1553)."
[ "$rc" -eq 0 ] || fail "deploy (rc=$rc)"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

# The recorder's CFn-generated name + role ARN, needed to re-PUT it out of band.
REC_NAME="$(aws configservice describe-configuration-recorders --region "$REGION" --query 'ConfigurationRecorders[0].name' --output text)"
REC_ROLE="$(aws configservice describe-configuration-recorders --region "$REGION" --query 'ConfigurationRecorders[0].roleARN' --output text)"
[ -n "$REC_NAME" ] && [ "$REC_NAME" != "None" ] || fail "could not read recorder name"

echo "=== [$STACK] out-of-band: widen recordingGroup.resourceTypes (add AWS::IAM::User) ==="
cat > /tmp/cdkrd-recorder-drift.json <<JSON
{ "name": "${REC_NAME}", "roleARN": "${REC_ROLE}",
  "recordingGroup": { "allSupported": false, "includeGlobalResourceTypes": false,
    "resourceTypes": ["AWS::S3::Bucket", "AWS::IAM::User"] } }
JSON
aws configservice put-configuration-recorder --region "$REGION" \
  --configuration-recorder "file:///tmp/cdkrd-recorder-drift.json" || fail "inject drift"

echo "=== [$STACK] check MUST DETECT the widened recording group ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-recorder-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "IAM::User\|ResourceTypes\|recordingGroup" /tmp/cdkrd-recorder-detect.out || fail "widened recordingGroup not reported"

echo "=== [$STACK] revert MUST restore [AWS::S3::Bucket] (PutConfigurationRecorder SDK writer) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-recorder-revert.out
grep -qi "reverted:" /tmp/cdkrd-recorder-revert.out || fail "revert did not report success"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "INTEG PASS ($STACK detect+revert)"

#!/usr/bin/env bash
# DynamoDB detect + revert integration test (real AWS): the "someone changed it in
# the console" scenario. Deploy -> record -> disable point-in-time recovery out of
# band (a declared, MUTABLE, nested property) -> check MUST DETECT the declared
# drift (exit 1) -> revert -> check MUST be CLEAN and the live PITR MUST be
# re-enabled. PITR toggles are near-instant and never put the table in UPDATING,
# so this is a fast, reliable detection oracle for a nested declared property.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDdbRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

TBL="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)"
[ -n "$TBL" ] || fail "could not resolve table physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: disable point-in-time recovery (console-edit) ==="
aws dynamodb update-continuous-backups --table-name "$TBL" --region "$REGION" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=false >/dev/null \
  || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ddb-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "PointInTimeRecovery" /tmp/cdkrd-ddb-detect.out || fail "PITR drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live PITR MUST be re-enabled ==="
GOT="$(aws dynamodb describe-continuous-backups --table-name "$TBL" --region "$REGION" \
  --query "ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus" --output text)"
[ "$GOT" = "ENABLED" ] || fail "live PITR not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

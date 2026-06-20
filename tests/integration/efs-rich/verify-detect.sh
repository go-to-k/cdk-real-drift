#!/usr/bin/env bash
# EFS detect + revert integration test (real AWS): the "someone changed it in the
# console" scenario. Deploy -> record -> disable the BackupPolicy out of band
# (ENABLED -> DISABLED, a declared, MUTABLE property stored by AWS as a separate
# associated resource) -> check MUST DETECT the declared drift (exit 1) -> revert ->
# check MUST be CLEAN and the live backup policy MUST be back to ENABLED. The backup
# policy flip is near-instant, so this is a fast, reliable detection oracle for a
# declared nested property that AWS materializes out-of-line.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEfsRich
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

FS="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EFS::FileSystem'].PhysicalResourceId" --output text)"
[ -n "$FS" ] || fail "could not resolve file system physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: disable backup policy (console-edit) ==="
aws efs put-backup-policy --file-system-id "$FS" --region "$REGION" \
  --backup-policy Status=DISABLED >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-efs-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "BackupPolicy\|Status" /tmp/cdkrd-efs-detect.out || fail "BackupPolicy drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live backup policy MUST be back to ENABLED ==="
GOT="$(aws efs describe-backup-policy --file-system-id "$FS" --region "$REGION" \
  --query "BackupPolicy.Status" --output text)"
[ "$GOT" = "ENABLED" ] || fail "live backup policy not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

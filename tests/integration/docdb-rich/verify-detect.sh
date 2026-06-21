#!/usr/bin/env bash
# DocumentDB detect + revert integration test (real AWS): the "someone changed the
# backup retention in the console" scenario. AWS::DocDB::DBCluster is a Cloud Control
# read+write gap, so detection relies on the DescribeDBClusters SDK override and revert
# on the ModifyDBCluster SDK writer. Deploy -> record -> bump the DECLARED MUTABLE
# BackupRetentionPeriod 3->5 out of band -> check MUST DETECT (exit 1) -> revert ->
# check MUST be CLEAN and retention restored to 3. (Aurora-class deploy: ~10 min.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDocdbRich
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

CLID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::DocDB::DBCluster'].PhysicalResourceId" --output text)"
[ -n "$CLID" ] && [ "$CLID" != "None" ] || fail "could not resolve DB cluster identifier"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: BackupRetentionPeriod 3->5 (console-edit) ==="
aws docdb modify-db-cluster --db-cluster-identifier "$CLID" --region "$REGION" \
  --backup-retention-period 5 --apply-immediately >/dev/null || fail "inject drift"
# ModifyDBCluster is async; the new value is visible immediately on describe.
sleep 5

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-docdb-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "BackupRetentionPeriod" /tmp/cdkrd-docdb-detect.out || fail "BackupRetentionPeriod not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
sleep 8

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live BackupRetentionPeriod MUST be restored to 3 ==="
GOT="$(aws docdb describe-db-clusters --db-cluster-identifier "$CLID" --region "$REGION" \
  --query "DBClusters[0].BackupRetentionPeriod" --output text)"
[ "$GOT" = "3" ] || fail "live BackupRetentionPeriod not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

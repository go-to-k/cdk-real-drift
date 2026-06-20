#!/usr/bin/env bash
# ElastiCache detect + revert integration test (real AWS): the "someone changed a
# cache setting in the console" scenario. Deploy -> record -> change a DECLARED
# MUTABLE scalar (SnapshotRetentionLimit 1->5) out of band via
# modify-replication-group -> check MUST DETECT (exit 1) -> revert -> check MUST
# be CLEAN and the live value restored to 1. Slow: each modify settles via the
# replication-group-available waiter.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegElastiCacheRich
RG=cdkrd-ec-rich
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

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: SnapshotRetentionLimit 1->5 (console-edit) ==="
aws elasticache modify-replication-group --replication-group-id "$RG" \
  --snapshot-retention-limit 5 --apply-immediately --region "$REGION" >/dev/null \
  || fail "inject drift"
aws elasticache wait replication-group-available --replication-group-id "$RG" --region "$REGION"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-elasticache-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "SnapshotRetentionLimit" /tmp/cdkrd-elasticache-detect.out || fail "SnapshotRetentionLimit not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
aws elasticache wait replication-group-available --replication-group-id "$RG" --region "$REGION"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live SnapshotRetentionLimit MUST be restored to 1 ==="
GOT="$(aws elasticache describe-replication-groups --replication-group-id "$RG" \
  --region "$REGION" --query "ReplicationGroups[0].SnapshotRetentionLimit" --output text)"
[ "$GOT" = "1" ] || fail "live SnapshotRetentionLimit not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

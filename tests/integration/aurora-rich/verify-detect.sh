#!/usr/bin/env bash
# Aurora detect + revert (real AWS): bump the declared MUTABLE cluster
# BackupRetentionPeriod 3->5 out of band -> check MUST DETECT (declared cluster drift
# + the change propagates to the writer/reader instances, caught as undeclared) ->
# revert the cluster -> after propagation check MUST be CLEAN and retention back to 3.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegAuroraRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
CLID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::RDS::DBCluster'].PhysicalResourceId" --output text)"
[ -n "$CLID" ] && [ "$CLID" != "None" ] || fail "no cluster id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob BackupRetentionPeriod 3->5 ==="
aws rds modify-db-cluster --db-cluster-identifier "$CLID" --backup-retention-period 5 --apply-immediately --region "$REGION" >/dev/null || fail "inject"
sleep 8
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-aurora-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "BackupRetentionPeriod" /tmp/cdkrd-aurora-detect.out || fail "BackupRetentionPeriod not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
sleep 15
echo "=== check CLEAN after revert ==="; $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
GOT="$(aws rds describe-db-clusters --db-cluster-identifier "$CLID" --region "$REGION" --query 'DBClusters[0].BackupRetentionPeriod' --output text)"
[ "$GOT" = "3" ] || fail "retention not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

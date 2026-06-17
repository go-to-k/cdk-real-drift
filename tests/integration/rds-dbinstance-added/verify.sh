#!/usr/bin/env bash
# cdk-real-drift `added` integ test for RDS (the SEVENTEENTH CHILD_ENUMERATORS member).
#   deploy fixture (VPC + Aurora MySQL cluster + ONE declared writer instance)
#   -> record (snapshots declared + the cluster/writer UNDECLARED properties)
#   -> `create-db-instance` an undeclared reader into the SAME cluster out of band
#   -> check reports ONLY that instance under [Not Recorded], NOT drift (exit 0)  [detection]
#   -> `revert --remove-unrecorded` DELETES it via Cloud Control DeleteResource    [revert]
#      (RDS deletes take 5-10 min; cdkrd's CC poll ceiling is 15 min)
#   -> check CLEAN
#   -> re-create the reader, `record` it, check CLEAN  [proves CC GetResource + normalize]
#   -> destroy.
# NOTE: we record the cluster/writer's undeclared properties up front, so the out-of-band
# instance is the ONLY unrecorded finding — `revert --remove-unrecorded` then targets just
# it (it must NOT try to revert the declared cluster/writer's many undeclared/create-only
# properties). Two reader instances are created (one for the revert proof, one for the
# record/GetResource proof) because a recorded `added` is no longer a revert candidate.
#
# Teardown is AIRTIGHT (an Aurora orphan bills indefinitely): the cleanup trap deletes any
# out-of-band instance off the cluster BEFORE delstack, waits for it to vanish, then
# delstack removes the writer + cluster, and verifies the cluster is gone.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegRdsDbInstanceAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OOB=cdkrd-integ-oob

fail() { echo "INTEG FAIL: $*"; exit 1; }

cleanup() {
  echo "--- cleanup ---"
  local cluster
  cluster="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::RDS::DBCluster'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)"
  if aws rds describe-db-instances --db-instance-identifier "$OOB" --region "$REGION" >/dev/null 2>&1; then
    aws rds delete-db-instance --db-instance-identifier "$OOB" --skip-final-snapshot --delete-automated-backups --region "$REGION" >/dev/null 2>&1 || true
    echo "waiting for out-of-band instance $OOB to delete..."
    aws rds wait db-instance-deleted --db-instance-identifier "$OOB" --region "$REGION" 2>/dev/null || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
  if [ -n "$cluster" ] && [ "$cluster" != "None" ]; then
    if aws rds describe-db-clusters --db-cluster-identifier "$cluster" --region "$REGION" >/dev/null 2>&1; then
      echo "WARNING: cluster $cluster still exists after teardown — manual cleanup needed"
    else
      echo "teardown verified: cluster gone"
    fi
  fi
}
trap cleanup EXIT

inject_oob() { # create the out-of-band reader + wait until available
  aws rds create-db-instance --db-instance-identifier "$OOB" --db-cluster-identifier "$CLUSTER" \
    --engine aurora-mysql --db-instance-class db.t3.medium --no-multi-az --region "$REGION" >/dev/null \
    || fail "create-db-instance"
  echo "waiting for $OOB to become available (~8-10 min)..."
  aws rds wait db-instance-available --db-instance-identifier "$OOB" --region "$REGION" || fail "oob instance never became available"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (Aurora — this takes ~10-12 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

CLUSTER="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBCluster'].PhysicalResourceId | [0]" --output text)"
[ -n "$CLUSTER" ] && [ "$CLUSTER" != "None" ] || fail "could not resolve DB cluster id"
echo "cluster: $CLUSTER"

echo "=== record (snapshot declared + cluster/writer undeclared properties) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared writer NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== [detection] add an undeclared reader instance out of band ==="
inject_oob

echo "=== check reports ONLY the instance as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-rds.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-rds.out || fail "added instance not under [Not Recorded]"
grep -q "AWS::RDS::DBInstance" /tmp/cdkrd-integ-rds.out || fail "the out-of-band instance not reported"
grep -q "added=" /tmp/cdkrd-integ-rds.out && fail "unrecorded added must not count as drift" || true

echo "=== [revert] revert --remove-unrecorded DELETES it (CC DeleteResource; ~5-10 min) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-rds-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-rds-revert.out || fail "revert did not report a reverted item"
aws rds wait db-instance-deleted --db-instance-identifier "$OOB" --region "$REGION" 2>/dev/null || true
if aws rds describe-db-instances --db-instance-identifier "$OOB" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted instance still exists (delete did not take effect)"
fi

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN after revert"

echo "=== [record/GetResource] re-create the reader, record it, expect CLEAN ==="
inject_oob
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-rds-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added instance, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-rds-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "INTEG PASS"

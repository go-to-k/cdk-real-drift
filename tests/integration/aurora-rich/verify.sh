#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. Amazon Aurora (AWS::RDS::DBCluster + ::DBInstance, read NATIVELY via
# Cloud Control) with a READER replica + custom cluster/instance PARAMETER GROUPS +
# version-track resolution is the user-flagged "scary" surface. Any drift on a clean
# recorded stack is a normalization / default-folding FP. (Aurora deploy: ~13 min.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAuroraRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] check (NO baseline): engine-derived RDS defaults must NOT surface as potential drift ==="
# ENGINE_DEFAULTS / DEFAULT_MANAGED_NAME_PATHS / the CACertificateIdentifier constant fold the
# values AWS fills in from the engine family (StorageType "aurora", LicenseModel, the default
# option group, the default CA) to atDefault, so a clean Aurora first run is not flooded with
# them. A regression un-folds one and it reappears here. (DBParameterGroupName is NOT asserted
# — this fixture pins a CUSTOM cluster/instance group, which correctly surfaces.)
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK-pre.out"
for prop in StorageType LicenseModel CACertificateIdentifier OptionGroupName; do
  grep -qE "\.$prop \(" "/tmp/cdkrd-$STACK-pre.out" \
    && fail "engine-derived default $prop surfaced as potential drift (ENGINE_DEFAULTS fold regressed)"
done
# The cluster parameter group declares `slow_query_log: "ON"`, which RDS canonicalizes to "1"
# on read — the ON≡1 boolean-token fold must keep it from false-flagging declared drift.
grep -qE "Parameters\.slow_query_log" "/tmp/cdkrd-$STACK-pre.out" \
  && fail "MySQL boolean param slow_query_log (ON vs live 1) surfaced as drift (ON≡1 fold regressed)"
# The DBInstance's live model ECHOES the DBCluster's cluster-level config (encryption, engine
# version, backup, security groups, subnet group). The CLUSTER_ECHO_CHILD strip must drop
# those from the instance — a regression re-floods them. Asserted per DBInstance line.
for prop in StorageEncrypted EngineVersion BackupRetentionPeriod DBSubnetGroupName VPCSecurityGroups; do
  grep -qE "\.$prop \(AWS::RDS::DBInstance\)" "/tmp/cdkrd-$STACK-pre.out" \
    && fail "DBInstance echo of cluster $prop surfaced (CLUSTER_ECHO_CHILD strip regressed)"
done
# AWS-ASSIGNED values a user never declared — the AZ placement, the randomly-assigned
# maintenance/backup windows, and the RDS Extended Support enrollment (EngineLifecycleSupport:
# set by the original creation era — a pre-Extended-Support lineage reads "…support-disabled" and
# a restore hides that behind the restore-date ClusterCreateTime — so it is AWS-assigned, not user
# intent) — fold value-independent. A regression un-folds one.
# (KmsKeyId only appears when encrypted; grepped best-effort.)
for prop in AvailabilityZone AvailabilityZones PreferredMaintenanceWindow PreferredBackupWindow KmsKeyId EngineLifecycleSupport; do
  grep -qE "\.$prop \(AWS::RDS::DB" "/tmp/cdkrd-$STACK-pre.out" \
    && fail "AWS-assigned $prop surfaced as potential drift (VALUE_INDEPENDENT fold regressed)"
done

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

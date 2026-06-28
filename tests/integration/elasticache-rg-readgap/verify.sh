#!/usr/bin/env bash
# ElastiCache ReplicationGroup writeOnly-read-gap integration test (real AWS).
#
# PreferredMaintenanceWindow / NotificationTopicArn / EngineVersion are writeOnly on
# the RG, so Cloud Control never echoes them — an out-of-band change to the
# maintenance window or notification topic was silently invisible. The SDK_SUPPLEMENTS
# reader reads them verbatim from the member cache cluster. This test proves: clean
# record -> check is CLEAN (incl. the EngineVersion "7.1"->"7.1.0" prefix fold), an
# out-of-band maintenance-window change is DETECTED, and revert restores it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegElastiCacheRgReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

RG_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ElastiCache::ReplicationGroup'].PhysicalResourceId | [0]" --output text)
[ -n "$RG_ID" ] && [ "$RG_ID" != "None" ] || fail "could not resolve ReplicationGroup id"
echo "ReplicationGroupId=$RG_ID"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN (verbatim props + EngineVersion prefix fold) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.clean.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] mutate PreferredMaintenanceWindow out of band ==="
# afternoon window — cannot overlap the declared 03:00-04:00 snapshot window
aws elasticache modify-replication-group --replication-group-id "$RG_ID" \
  --preferred-maintenance-window "wed:14:00-wed:15:00" --apply-immediately --region "$REGION" >/dev/null || fail "modify-replication-group"
# the change can take a moment to reflect on the member cluster
sleep 15

echo "=== [$STACK] check MUST DETECT the maintenance-window drift (no false negative) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.drift.out"
rc=${PIPESTATUS[0]}
[ "$rc" -ne 0 ] || { echo "--- FALSE NEGATIVE: maintenance-window change not detected ---"; fail "expected drift (exit 1), got $rc"; }
grep -qi "PreferredMaintenanceWindow" "/tmp/cdkrd-$STACK.drift.out" || fail "drift output does not mention PreferredMaintenanceWindow"

echo "=== [$STACK] revert (write declared window back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
sleep 15

echo "=== [$STACK] live maintenance window must be back to the declared value ==="
MEMBER=$(aws elasticache describe-replication-groups --replication-group-id "$RG_ID" --region "$REGION" --query 'ReplicationGroups[0].MemberClusters[0]' --output text)
LIVE=$(aws elasticache describe-cache-clusters --cache-cluster-id "$MEMBER" --region "$REGION" --query 'CacheClusters[0].PreferredMaintenanceWindow' --output text)
[ "$LIVE" = "sun:05:00-sun:06:00" ] || fail "revert did not restore the maintenance window (got: $LIVE)"

echo "=== [$STACK] check MUST be CLEAN again after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert (exit 0), got $rc"

echo "INTEG PASS ($STACK)"

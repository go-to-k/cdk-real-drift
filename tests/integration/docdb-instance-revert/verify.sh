#!/usr/bin/env bash
# DocDB DBInstance detect->revert->clean (real AWS, mutating). Proves writeDocDbInstance
# (ModifyDBInstance) reverts an out-of-band PreferredMaintenanceWindow change.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegDocdbInstanceRevert; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
IID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::DocDB::DBInstance'].PhysicalResourceId" --output text)"
[ -n "$IID" ] || fail "could not resolve DB instance id"
echo "instance=$IID"
echo "=== record + check CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"
echo "=== change PreferredMaintenanceWindow out of band ==="
aws docdb modify-db-instance --db-instance-identifier "$IID" --preferred-maintenance-window "mon:07:00-mon:08:00" --apply-immediately --region "$REGION" >/dev/null || fail "out-of-band modify"
sleep 8
echo "=== check DETECTS (exit 1, PreferredMaintenanceWindow) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/dbi-pre.out; [ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "PreferredMaintenanceWindow" /tmp/dbi-pre.out || fail "PreferredMaintenanceWindow drift not reported"
echo "=== revert --yes ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/dbi-rev.out || fail "revert non-zero"
sleep 10
echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert (revert no-op bug)"
echo "=== confirm live window restored ==="
GOT="$(aws docdb describe-db-instances --db-instance-identifier "$IID" --region "$REGION" --query 'DBInstances[0].PreferredMaintenanceWindow' --output text)"
[ "$GOT" = "sun:05:00-sun:06:00" ] || fail "live PreferredMaintenanceWindow not restored (got: $GOT)"
echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# cdk-real-drift `added` integ test for AppSync (the SIXTH CHILD_ENUMERATORS member).
#   deploy fixture (GraphQL API + one declared NONE data source) -> record -> CLEAN
#   -> create-data-source an undeclared data source on the SAME api out of band -> check
#      reports the data source under [Potential Drift] and is NOT drift (exit 0) -> `record`
#      snapshots it (proves CC GetResource + normalize for AWS::AppSync::DataSource) -> CLEAN
#   -> add ANOTHER out-of-band data source -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the GraphQLApi cascades its data sources (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/appsync-datasource-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegAppSyncDataSourceAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting the GraphQLApi cascades its data sources, so delstack (which deletes the
  # stack and its members) suffices — no stack-external sweep needed.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

# AppSync data source names allow only [_A-Za-z0-9] (NO hyphens) -> use underscores.
inject_ds() { # $1 = data source name -> creates a NONE data source on the api
  aws appsync create-data-source --api-id "$APIID" --name "$1" --type NONE --region "$REGION" \
    >/dev/null || fail "create-data-source $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

# The GraphQLApi physical id is the ApiId, possibly an ARN. `list-data-sources` wants the
# bare api id; if the physical id is an ARN, take the trailing api-id segment.
APIPHYS="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::AppSync::GraphQLApi'].PhysicalResourceId" --output text)"
[ -n "$APIPHYS" ] || fail "could not resolve GraphQLApi physical id"
APIID="$(echo "$APIPHYS" | awk -F/ '{print $NF}')"
# Sanity: the bare api-id form must be accepted by list-data-sources.
aws appsync list-data-sources --api-id "$APIID" --region "$REGION" >/dev/null 2>&1 || APIID="$APIPHYS"
aws appsync list-data-sources --api-id "$APIID" --region "$REGION" >/dev/null || fail "list-data-sources rejected api id forms"

echo "=== create an undeclared data source on the api out of band ==="
inject_ds cdkrd_integ_oob_record

echo "=== check reports the data source as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-appsync.out || fail "added data source not under [Potential Drift]"
grep -q "AWS::AppSync::DataSource" /tmp/cdkrd-integ-appsync.out || fail "the out-of-band data source not reported"
grep -q "added=" /tmp/cdkrd-integ-appsync.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added data source (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for AppSync::DataSource) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added data source, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-appsync-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band data source for the revert path ==="
inject_ds cdkrd_integ_oob_revert

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-appsync-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-appsync-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-appsync-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second data source must be gone from AWS ==="
if aws appsync get-data-source --api-id "$APIID" --name cdkrd_integ_oob_revert --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted data source still exists (delete did not take effect)"
fi

echo "INTEG PASS"

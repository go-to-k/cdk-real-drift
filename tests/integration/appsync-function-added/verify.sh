#!/usr/bin/env bash
# cdk-real-drift `added` integ test for AppSync FUNCTIONS (extending the AppSync
# CHILD_ENUMERATORS member to AWS::AppSync::FunctionConfiguration).
#   deploy fixture (GraphQL API + one NONE data source + one declared function) -> record
#   -> CLEAN (the declared function must NOT be flagged)
#   -> create-function an undeclared function on the SAME api out of band -> check reports
#      the function under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots it
#      (proves CC GetResource on the FunctionArn) -> CLEAN
#   -> add ANOTHER out-of-band function -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the GraphQLApi cascades its functions (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/appsync-function-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegAppSyncFunctionAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Delete the GraphQLApi FIRST: it cascades its data sources AND functions in one shot.
  # CloudFormation otherwise tries to delete the DataSource while a Function still
  # references it, leaving the stack DELETE_FAILED on AWS::AppSync::DataSource (which
  # delstack cannot force-delete). Deleting the api up front removes that ordering trap.
  if [ -n "${APIID:-}" ]; then
    aws appsync delete-graphql-api --api-id "$APIID" --region "$REGION" >/dev/null 2>&1 || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

# AppSync function names allow only [_A-Za-z0-9] (NO hyphens) -> use camelCase.
inject_fn() { # $1 = function name -> creates a NONE-backed function on the api
  aws appsync create-function --api-id "$APIID" --name "$1" --data-source-name "$DS" \
    --runtime name=APPSYNC_JS,runtimeVersion=1.0.0 \
    --code 'export function request(){return {};} export function response(ctx){return ctx.result;}' \
    --region "$REGION" >/dev/null \
    || aws appsync create-function --api-id "$APIID" --name "$1" --data-source-name "$DS" \
       --function-version 2018-05-29 \
       --request-mapping-template '{}' --response-mapping-template '$util.toJson($ctx.result)' \
       --region "$REGION" >/dev/null \
    || fail "create-function $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared function NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

# The GraphQLApi physical id is the ApiId, possibly an ARN. `list-functions` wants the
# bare api id; if the physical id is an ARN, take the trailing api-id segment.
APIPHYS="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::AppSync::GraphQLApi'].PhysicalResourceId" --output text)"
[ -n "$APIPHYS" ] || fail "could not resolve GraphQLApi physical id"
APIID="$(echo "$APIPHYS" | awk -F/ '{print $NF}')"
# Sanity: the bare api-id form must be accepted by list-functions.
aws appsync list-functions --api-id "$APIID" --region "$REGION" >/dev/null 2>&1 || APIID="$APIPHYS"
aws appsync list-functions --api-id "$APIID" --region "$REGION" >/dev/null || fail "list-functions rejected api id forms"

# Resolve a data source name on the api to back the out-of-band functions.
DS="$(aws appsync list-data-sources --api-id "$APIID" --region "$REGION" --query 'dataSources[0].name' --output text)"
[ -n "$DS" ] && [ "$DS" != "None" ] || fail "could not resolve a data source name on the api"

echo "=== create an undeclared function on the api out of band ==="
inject_fn cdkrdIntegOobRecord

echo "=== check reports the function as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-fn.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appsync-fn.out || fail "added function not under [Not Recorded]"
grep -q "AWS::AppSync::FunctionConfiguration" /tmp/cdkrd-integ-appsync-fn.out || fail "the out-of-band function not reported"
grep -q "added=" /tmp/cdkrd-integ-appsync-fn.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added function (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the FunctionArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-fn-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added function, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appsync-fn-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band function for the revert path ==="
inject_fn cdkrdIntegOobRevert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-fn-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-appsync-fn-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-appsync-fn-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-appsync-fn-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second function must be gone from AWS ==="
REVID="$(aws appsync list-functions --api-id "$APIID" --region "$REGION" \
  --query "functions[?name=='cdkrdIntegOobRevert'].functionId" --output text)"
if [ -n "$REVID" ] && [ "$REVID" != "None" ]; then
  fail "the reverted function still exists (delete did not take effect)"
fi

echo "INTEG PASS"

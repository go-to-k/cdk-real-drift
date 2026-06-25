#!/usr/bin/env bash
# cdk-real-drift `added` integ test for AppSync RESOLVERS (the AppSync CHILD_ENUMERATORS
# member, extended from data sources to also enumerate resolvers).
#   deploy fixture (GraphQL API + one declared NONE data source + one declared resolver
#     on Query.ping) -> record -> CLEAN (the declared Query.ping resolver must NOT flag)
#   -> create-resolver an undeclared resolver on Query.pong out of band -> check reports
#      the resolver under [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots
#      it (proves CC GetResource + normalize for AWS::AppSync::Resolver) -> CLEAN
#   -> create-resolver ANOTHER out-of-band resolver on Query.pung -> `revert
#      --remove-unrecorded` DELETES it via Cloud Control DeleteResource -> check CLEAN
#      -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting the GraphQLApi cascades its resolvers (no orphans).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/appsync-resolver-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegAppSyncResolverAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # The recorded (kept, not reverted) out-of-band Query.pong resolver stays attached to
  # the declared NONE data source and would block that DataSource's CFn deletion
  # (DELETE_FAILED). Detach any non-declared resolvers first, then delete the stack;
  # deleting the GraphQLApi cascades the rest (the declared Query.ping resolver), so no
  # stack-external sweep is needed.
  if [ -n "${APIID:-}" ]; then
    for f in pong pung; do
      aws appsync delete-resolver --api-id "$APIID" --type-name Query --field-name "$f" \
        --region "$REGION" >/dev/null 2>&1 || true
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

REQ_TMPL='{"version":"2018-05-29","payload":{}}'
RES_TMPL='$util.toJson($ctx.result)'

inject_resolver() { # $1 = field name -> creates a resolver on Query.<field> via the NONE ds
  aws appsync create-resolver --api-id "$APIID" --type-name Query --field-name "$1" \
    --data-source-name "$DS" --request-mapping-template "$REQ_TMPL" \
    --response-mapping-template "$RES_TMPL" --region "$REGION" \
    >/dev/null || fail "create-resolver Query.$1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared Query.ping resolver must NOT flag) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

# The GraphQLApi physical id is the ApiId, possibly an ARN. AppSync resolver/datasource
# APIs want the bare api id; if the physical id is an ARN, take the trailing api-id segment.
APIPHYS="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::AppSync::GraphQLApi'].PhysicalResourceId" --output text)"
[ -n "$APIPHYS" ] || fail "could not resolve GraphQLApi physical id"
APIID="$(echo "$APIPHYS" | awk -F/ '{print $NF}')"
# Sanity: the bare api-id form must be accepted by list-data-sources.
aws appsync list-data-sources --api-id "$APIID" --region "$REGION" >/dev/null 2>&1 || APIID="$APIPHYS"
aws appsync list-data-sources --api-id "$APIID" --region "$REGION" >/dev/null || fail "list-data-sources rejected api id forms"

# The NONE data source the resolvers attach to (the one declared by the fixture).
DS="$(aws appsync list-data-sources --api-id "$APIID" --region "$REGION" --query 'dataSources[0].name' --output text)"
[ -n "$DS" ] && [ "$DS" != "None" ] || fail "could not resolve a data source name for the resolvers"

echo "=== create an undeclared resolver on Query.pong out of band ==="
inject_resolver pong

echo "=== check reports the resolver as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-res.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-appsync-res.out || fail "added resolver not under [Potential Drift]"
grep -q "AWS::AppSync::Resolver" /tmp/cdkrd-integ-appsync-res.out || fail "the out-of-band resolver not reported"
grep -q "added=" /tmp/cdkrd-integ-appsync-res.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added resolver (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the ResolverArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-res-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added resolver, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-appsync-res-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== create ANOTHER out-of-band resolver on Query.pung for the revert path ==="
inject_resolver pung

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appsync-res-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-appsync-res-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-appsync-res-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-appsync-res-revert.out || fail "revert did not converge to CLEAN"

echo "=== the Query.pung resolver must be gone from AWS ==="
if aws appsync get-resolver --api-id "$APIID" --type-name Query --field-name pung --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted resolver still exists (delete did not take effect)"
fi

echo "INTEG PASS"

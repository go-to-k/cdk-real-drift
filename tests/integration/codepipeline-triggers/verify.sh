#!/usr/bin/env bash
# Integration test (real AWS) for the CodePipeline V2 Git trigger-filter reorder FP.
# A V2 pipeline with a CodeStar (CodeConnections) GitHub source and a Triggers
# GitConfiguration (push filters: Branches Includes/Excludes, FilePaths Includes/Excludes)
# whose filter lists are `uniqueItems: true` schema arrays WITHOUT `insertionOrder: false`.
# CodePipeline stores them as SETS, so an out-of-band reorder of an identical list reads
# back in a different order — which a positional compare false-drifted before the
# UNORDERED_ARRAY_PROPS fold for these trigger paths.
#
# Asserts, end to end:
#   1. deploy -> record -> check is CLEAN (baseline FP oracle),
#   2. out-of-band REORDER of Branches.Includes (same set) -> check STILL CLEAN (FP guard),
#   3. out-of-band REMOVE of a branch (real change) -> check DETECTS declared drift (FN guard).
#
# Self-provisions a PENDING CodeConnections GitHub connection (fine: the pipeline stores
# its trigger config without the connection being authorized — we never run the pipeline)
# and deletes it on cleanup. Set CDKRD_CONNECTION_ARN to reuse an existing connection.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodepipelineTriggers
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
PIPELINE=cdkrd-triggers-pipeline
OWN_CONN=""

CONN="${CDKRD_CONNECTION_ARN:-}"
if [ -z "$CONN" ]; then
  CONN="$(aws codeconnections create-connection --provider-type GitHub \
    --connection-name "cdkrd-triggers-$RANDOM" --region "$REGION" \
    --query ConnectionArn --output text)" || { echo "INTEG FAIL ($STACK): create-connection"; exit 1; }
  OWN_CONN="$CONN"
fi

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  [ -n "$OWN_CONN" ] && aws codeconnections delete-connection --connection-arn "$OWN_CONN" --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never -c "connectionArn=$CONN" || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes -c "connectionArn=$CONN" || fail "record"

echo "=== [$STACK] (1) check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail -c "connectionArn=$CONN" || fail "expected CLEAN after record"

echo "=== [$STACK] (2) out-of-band REORDER of Branches.Includes (same set) -> STILL CLEAN ==="
aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" --query pipeline > /tmp/cpt-pl.json || fail "get-pipeline"
python3 - <<'PY'
import json
p=json.load(open('/tmp/cpt-pl.json'))
b=p['triggers'][0]['gitConfiguration']['push'][0]['branches']
b['includes']=list(reversed(b['includes']))  # reorder only (semantic no-op for a set)
json.dump({'pipeline':p},open('/tmp/cpt-reorder.json','w'))
PY
aws codepipeline update-pipeline --cli-input-json file:///tmp/cpt-reorder.json --region "$REGION" >/dev/null || fail "update reorder"
$CLI check "$STACK" --region "$REGION" --fail -c "connectionArn=$CONN" \
  || fail "FALSE POSITIVE: a set-reorder of Branches.Includes was reported as drift"

echo "=== [$STACK] (3) out-of-band REMOVE a branch (real change) -> MUST DETECT ==="
python3 - <<'PY'
import json
p=json.load(open('/tmp/cpt-pl.json'))
b=p['triggers'][0]['gitConfiguration']['push'][0]['branches']
b['includes']=b['includes'][:-1]  # drop one branch (real multiset change)
json.dump({'pipeline':p},open('/tmp/cpt-remove.json','w'))
PY
aws codepipeline update-pipeline --cli-input-json file:///tmp/cpt-remove.json --region "$REGION" >/dev/null || fail "update remove"
$CLI check "$STACK" --region "$REGION" --fail -c "connectionArn=$CONN"
rc=$?
[ "$rc" -eq 1 ] || fail "FALSE NEGATIVE: removing a branch was not detected (exit $rc, expected 1)"

echo "INTEG PASS ($STACK)"

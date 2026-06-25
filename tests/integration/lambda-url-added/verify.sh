#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Lambda function URLs (extending the FOURTH
# CHILD_ENUMERATORS member, AWS::Lambda::Function).
#   deploy fixture (FnDeclared WITH a declared URL + FnTarget with NO URL) -> record ->
#      CLEAN (FnDeclared's declared URL must NOT be flagged) -> create-function-url-config
#      on FnTarget out of band -> check reports the URL under [Potential Drift] and is NOT
#      drift (exit 0) -> `revert --remove-unrecorded` DELETES it via Cloud Control
#      DeleteResource (URL must be UNRECORDED — record is done before the inject) ->
#      reinject the URL -> `record` snapshots it (proves CC GetResource + normalize for
#      AWS::Lambda::Url) -> CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; the URL is removed with the function.
#
# NOTE on ordering: an unqualified function URL's CC primaryIdentifier IS the bare
# function ARN, so a delete+reinject yields the SAME identifier — once recorded it would
# keep matching the baseline. Therefore the revert (delete) path is exercised while the
# URL is still UNRECORDED (record runs before the inject), and the GetResource/record path
# is exercised afterwards by reinjecting + recording.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/lambda-url-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLambdaUrlAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

fn_name_by_logical() { # $1 = logical-id prefix -> echoes the Function physical name
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, '$1')].PhysicalResourceId | [0]" \
    --output text
}

inject_url() { # creates a public (AuthType NONE) function URL on FnTarget out of band
  aws lambda create-function-url-config --function-name "$FNTARGET" --auth-type NONE \
    --region "$REGION" >/dev/null || fail "create-function-url-config"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

# Let IAM role Arn/RoleId become readable via Cloud Control before the first record so the
# baseline captures them (else they 'appear since record' on the next check — eventual
# consistency, not real drift).
echo "=== settle for IAM eventual consistency ==="
for _ in 1 2 3 4 5 6; do
  $CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 && break
  sleep 5
done

echo "=== record (write baseline; FnTarget has NO URL yet) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (FnDeclared's declared URL must NOT be flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-url-clean0.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record; declared URL wrongly flagged?"
grep -q "Potential Drift" /tmp/cdkrd-integ-url-clean0.out && fail "declared URL wrongly flagged as added" || true

FNTARGET="$(fn_name_by_logical FnTarget)"
[ -n "$FNTARGET" ] && [ "$FNTARGET" != "None" ] || fail "could not resolve FnTarget name"

echo "=== create an undeclared (public) function URL on FnTarget out of band ==="
inject_url

echo "=== check reports the URL as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-url.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-url.out || fail "added URL not under [Potential Drift]"
grep -q "AWS::Lambda::Url" /tmp/cdkrd-integ-url.out || fail "the out-of-band function URL not reported"
grep -q "added=" /tmp/cdkrd-integ-url.out && fail "unrecorded added must not count as drift" || true

echo "=== revert --remove-unrecorded DELETES the UNRECORDED URL (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-url-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-url-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-url-revert.out || fail "revert did not converge to CLEAN"

echo "=== the function URL must be gone from AWS ==="
if aws lambda get-function-url-config --function-name "$FNTARGET" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted function URL still exists (delete did not take effect)"
fi

echo "=== reinject the URL and record it (snapshot; KEEP watching) ==="
inject_url
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for AWS::Lambda::Url) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-url-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added URL, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-url-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "INTEG PASS"

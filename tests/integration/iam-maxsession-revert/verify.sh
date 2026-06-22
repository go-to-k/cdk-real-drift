#!/usr/bin/env bash
# cdkrd IAM MaxSessionDuration SET-DEFAULT REVERT integration test (real AWS, mutating).
# Proves a SET-DEFAULT property (REVERT_SET_DEFAULT_PATHS) converges on revert.
#
# IAM's UpdateRole leaves MaxSessionDuration UNCHANGED when it is absent from the desired
# model, so a bare RFC6902 `remove /MaxSessionDuration` is a SILENT no-op — Cloud Control
# reports SUCCESS yet the live value persists, and `check` after `revert` still shows the
# drift. The fix writes the known AWS default (3600) explicitly instead.
#
# Flow: deploy a role that does NOT declare MaxSessionDuration (live default 3600) ->
# record (baseline snapshot-complete; the at-default value is not a recorded entry) ->
# check CLEAN -> set MaxSessionDuration=7200 out of band -> check DETECTS "appeared since
# record = 7200" (exit 1) -> revert --yes -> check CLEAN -> direct AWS read confirms
# MaxSessionDuration is back to 3600 -> destroy.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamMaxSession
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp pack) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

ROLE="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" --output text)"
[ -n "$ROLE" ] || fail "could not resolve role name"
echo "role: $ROLE"

echo "=== record (baseline snapshot-complete; MaxSessionDuration at default 3600) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record

echo "=== check CLEAN (default MaxSessionDuration is not drift) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ms-clean.out
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "=== set MaxSessionDuration=7200 out of band ==="
aws iam update-role --role-name "$ROLE" --max-session-duration 7200 --region "$REGION" || fail "update-role"
sleep 5

echo "=== check DETECTS the appeared-since-record value (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ms-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1 after MaxSessionDuration change"
grep -q "MaxSessionDuration" /tmp/cdkrd-ms-pre.out || fail "MaxSessionDuration drift not reported"

echo "=== revert --yes (must write 3600, NOT a no-op remove) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-ms-revert.out || fail "revert returned non-zero"
sleep 5

echo "=== check CLEAN after revert (the bug: drift remained here) ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert (the silent no-op bug)"

echo "=== belt-and-suspenders: MaxSessionDuration is back to 3600 ==="
LIVE="$(aws iam get-role --role-name "$ROLE" --region "$REGION" \
  --query 'Role.MaxSessionDuration' --output text 2>/dev/null)"
echo "live MaxSessionDuration: '$LIVE'"
[ "$LIVE" = "3600" ] || fail "MaxSessionDuration not reset by revert (got '$LIVE')"

echo "INTEG PASS (CdkRealDriftIntegIamMaxSession set-default revert converges MaxSessionDuration to 3600)"

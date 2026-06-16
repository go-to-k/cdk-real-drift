#!/usr/bin/env bash
# cdk-real-drift `added` integ test for AppConfig (the FOURTEENTH CHILD_ENUMERATORS member).
#   deploy fixture (AppConfig Application + one declared Environment) -> record -> CLEAN
#   -> create-environment an undeclared environment on the SAME application out of band
#      -> check reports the environment under [Not Recorded] and is NOT drift (exit 0)
#      -> `record` snapshots it (proves CC GetResource on the composite id) -> CLEAN
#   -> add ANOTHER out-of-band environment -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap removes the
# out-of-band environments (they would block the application's deletion) and destroys the
# stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/appconfig-env-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegAppConfigEnvAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

resolve_app() { # echoes the AppConfig Application id (the ApplicationId)
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::AppConfig::Application'].PhysicalResourceId" \
    --output text 2>/dev/null
}

cleanup() {
  echo "--- cleanup ---"
  # A recorded-but-not-reverted out-of-band environment lingers on the application and
  # BLOCKS the application's deletion (AppConfig refuses to delete an application that
  # still has environments) -> the stack goes DELETE_FAILED, and delstack only sees STACK
  # members, not a stack-external environment sitting on a member application. So sweep any
  # out-of-band environments off the application FIRST.
  local app
  app="$(resolve_app)"
  if [ -n "$app" ] && [ "$app" != "None" ]; then
    for e in $(aws appconfig list-environments --application-id "$app" --region "$REGION" \
      --query "Items[?starts_with(Name, 'cdkrd-integ-oob')].Id" --output text 2>/dev/null); do
      aws appconfig delete-environment --application-id "$app" --environment-id "$e" \
        --region "$REGION" >/dev/null 2>&1 || true
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_env() { # $1 = environment name -> creates an environment on the application
  aws appconfig create-environment --application-id "$APPID" --name "$1" --region "$REGION" \
    >/dev/null || fail "create-environment $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared environment NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

APPID="$(resolve_app)"
[ -n "$APPID" ] && [ "$APPID" != "None" ] || fail "could not resolve AppConfig Application id"

echo "=== create an undeclared environment on the application out of band ==="
inject_env cdkrd-integ-oob-record

echo "=== check reports the environment as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appconfig.out || fail "added environment not under [Not Recorded]"
grep -q "AWS::AppConfig::Environment" /tmp/cdkrd-integ-appconfig.out || fail "the out-of-band environment not reported"
grep -q "added=" /tmp/cdkrd-integ-appconfig.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added environment (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite id) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added environment, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appconfig-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band environment for the revert path ==="
inject_env cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-appconfig-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-appconfig-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-appconfig-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second environment must be gone from AWS ==="
left="$(aws appconfig list-environments --application-id "$APPID" --region "$REGION" \
  --query "Items[?Name=='cdkrd-integ-oob-revert']" --output json 2>/dev/null)"
[ "$left" = "[]" ] || fail "the reverted environment still exists (delete did not take effect)"

echo "INTEG PASS"

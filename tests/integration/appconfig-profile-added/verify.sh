#!/usr/bin/env bash
# cdk-real-drift `added` integ test for AppConfig configuration profiles (a second child of
# the FOURTEENTH CHILD_ENUMERATORS member, alongside environments).
#   deploy fixture (AppConfig Application + one declared ConfigurationProfile) -> record
#   -> CLEAN
#   -> create-configuration-profile an undeclared profile on the SAME application out of band
#      -> check reports the profile under [Not Recorded] and is NOT drift (exit 0)
#      -> `record` snapshots it (proves CC GetResource on the composite id) -> CLEAN
#   -> add ANOTHER out-of-band profile -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap removes the
# out-of-band profiles (they would block the application's deletion) and destroys the
# stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/appconfig-profile-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegAppConfigProfileAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

resolve_app() { # echoes the AppConfig Application id (the ApplicationId)
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::AppConfig::Application'].PhysicalResourceId" \
    --output text 2>/dev/null
}

cleanup() {
  echo "--- cleanup ---"
  # A recorded-but-not-reverted out-of-band profile lingers on the application and BLOCKS
  # the application's deletion (AppConfig refuses to delete an application that still has
  # configuration profiles) -> the stack goes DELETE_FAILED, and delstack only sees STACK
  # members, not a stack-external profile sitting on a member application. So sweep any
  # out-of-band profiles off the application FIRST.
  local app
  app="$(resolve_app)"
  if [ -n "$app" ] && [ "$app" != "None" ]; then
    for p in $(aws appconfig list-configuration-profiles --application-id "$app" --region "$REGION" \
      --query "Items[?starts_with(Name, 'cdkrd-integ-oob')].Id" --output text 2>/dev/null); do
      aws appconfig delete-configuration-profile --application-id "$app" --configuration-profile-id "$p" \
        --region "$REGION" >/dev/null 2>&1 || true
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_profile() { # $1 = profile name -> creates a configuration profile on the application
  aws appconfig create-configuration-profile --application-id "$APPID" --name "$1" \
    --location-uri hosted --region "$REGION" >/dev/null || fail "create-configuration-profile $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared profile NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

APPID="$(resolve_app)"
[ -n "$APPID" ] && [ "$APPID" != "None" ] || fail "could not resolve AppConfig Application id"

echo "=== create an undeclared configuration profile on the application out of band ==="
inject_profile cdkrd-integ-oob-record

echo "=== check reports the profile as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig-prof.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appconfig-prof.out || fail "added profile not under [Not Recorded]"
grep -q "AWS::AppConfig::ConfigurationProfile" /tmp/cdkrd-integ-appconfig-prof.out || fail "the out-of-band profile not reported"
grep -q "added=" /tmp/cdkrd-integ-appconfig-prof.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added profile (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite id) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig-prof-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added profile, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-appconfig-prof-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band profile for the revert path ==="
inject_profile cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-appconfig-prof-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-appconfig-prof-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-appconfig-prof-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-appconfig-prof-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second profile must be gone from AWS ==="
left="$(aws appconfig list-configuration-profiles --application-id "$APPID" --region "$REGION" \
  --query "Items[?Name=='cdkrd-integ-oob-revert']" --output json 2>/dev/null)"
[ "$left" = "[]" ] || fail "the reverted profile still exists (delete did not take effect)"

echo "INTEG PASS"

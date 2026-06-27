#!/usr/bin/env bash
# ConfigRule detect integration test (real AWS): the governance-weakening scenario.
# Provision a recorder (SDK) -> deploy rule -> record -> weaken maxAccessKeyAge
# 90 -> 365 out of band (someone loosens a rotation rule) -> check MUST DETECT
# (exit 1, reporting InputParameters.maxAccessKeyAge) -> restore the rule manually.
#
# This is DETECT-ONLY: revert is NOT exercised. AWS::Config::ConfigRule stores
# InputParameters as a JSON STRING, so cdkrd descends into it for a precise nested
# finding, but the revert's RFC6902 sub-path patch (/InputParameters/maxAccessKeyAge)
# cannot apply to a string value — revert honestly reports non-convergence rather than
# silently failing. Reverting into a JSON-string property is a known limitation (a
# follow-up SDK_WRITERS / whole-property-revert task), like Route53 RecordSet's revert
# gap. Detection — catching the unauthorized weakening — is the point and works.
set -uo pipefail
export AWS_CLI_AUTO_PROMPT=off
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
# shellcheck source=/dev/null
source "$HERE/recorder-setup.sh"
STACK=CdkRealDriftIntegConfigRule
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  teardown_recorder "$REGION"
  rm -rf .cdkrd cdk.out /tmp/config-rule-*.json
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== provision Config recorder (SDK) ==="
setup_recorder "$REGION" || fail "recorder setup"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: maxAccessKeyAge 90 -> 365 (governance weakening) ==="
cat > /tmp/config-rule-365.json <<'JSON'
{ "ConfigRuleName": "cdkrd-access-keys-rotated", "Source": { "Owner": "AWS", "SourceIdentifier": "ACCESS_KEYS_ROTATED" },
  "InputParameters": "{\"maxAccessKeyAge\":\"365\"}", "MaximumExecutionFrequency": "TwentyFour_Hours" }
JSON
aws configservice put-config-rule --region "$REGION" --config-rule file:///tmp/config-rule-365.json || fail "inject drift"

echo "=== check MUST DETECT the weakening ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-config-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "maxAccessKeyAge" /tmp/cdkrd-config-detect.out || fail "weakened parameter not reported"

echo "=== restore the rule to 90 (manual; revert-into-JSON-string is a known gap) ==="
cat > /tmp/config-rule-90.json <<'JSON'
{ "ConfigRuleName": "cdkrd-access-keys-rotated", "Source": { "Owner": "AWS", "SourceIdentifier": "ACCESS_KEYS_ROTATED" },
  "InputParameters": "{\"maxAccessKeyAge\":\"90\"}", "MaximumExecutionFrequency": "TwentyFour_Hours" }
JSON
aws configservice put-config-rule --region "$REGION" --config-rule file:///tmp/config-rule-90.json || fail "restore"

echo "=== check MUST be CLEAN after restore ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after restore"

echo "INTEG PASS ($STACK detect)"

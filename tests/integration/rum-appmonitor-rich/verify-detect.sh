#!/usr/bin/env bash
# RUM AppMonitor detect + revert integration test (real AWS): deploy -> record ->
# change a DECLARED MUTABLE prop (AppMonitorConfiguration.SessionSampleRate) out of
# band -> check MUST DETECT the declared drift (exit 1) -> revert -> check MUST be
# CLEAN and the live value MUST be restored. This is the false-negative half a
# plain record->check->CLEAN fixture (verify.sh) does not exercise.
set -uo pipefail
export AWS_CLI_AUTO_PROMPT=off
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRumRich
NAME=cdkrd-rum-rich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out /tmp/rum-amc.json
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: SessionSampleRate 1 -> 0.5 (console-edit) ==="
# update-app-monitor overwrites the whole AppMonitorConfiguration, so resend the
# full declared config with only SessionSampleRate changed.
cat > /tmp/rum-amc.json <<'JSON'
{
  "AllowCookies": true,
  "EnableXRay": false,
  "SessionSampleRate": 0.5,
  "Telemetries": ["performance", "errors", "http"],
  "ExcludedPages": ["https://example.com/zeta", "https://example.com/alpha", "https://example.com/mike"],
  "IncludedPages": ["https://example.com/include-b", "https://example.com/include-a"],
  "FavoritePages": ["/zeta", "/alpha", "/mike"],
  "MetricDestinations": [{ "Destination": "CloudWatch" }]
}
JSON
aws rum update-app-monitor --name "$NAME" --region "$REGION" \
  --app-monitor-configuration file:///tmp/rum-amc.json >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-rum-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "SessionSampleRate" /tmp/cdkrd-rum-detect.out || fail "SessionSampleRate not reported"

echo "=== revert (write declared values back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live value MUST be restored to 1 ==="
GOT="$(aws rum get-app-monitor --name "$NAME" --region "$REGION" \
  --query "AppMonitor.AppMonitorConfiguration.SessionSampleRate" --output text)"
[ "$GOT" = "1.0" ] || [ "$GOT" = "1" ] || fail "live SessionSampleRate not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

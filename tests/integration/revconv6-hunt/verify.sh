#!/usr/bin/env bash
# Revert-convergence probes: RestoreTestingPlan SelectionWindowDays + RUM
# AppMonitorConfiguration. Deploy -> first check CLEAN -> record -> mutate both
# OOB -> detect (exit 1) -> revert -> LIVE values MUST be back at defaults.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722Rc6
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
RTP_NAME=cdkrd_hunt0722_rtp
RUM_NAME=cdkrd-hunt0722-rum

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-revconv6}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"
grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out" && fail "resources skipped (read gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "=== [$STACK] OOB mutate: RTP SelectionWindowDays 30->7 ==="
aws backup update-restore-testing-plan --restore-testing-plan-name "$RTP_NAME" \
  --restore-testing-plan '{"RecoveryPointSelection":{"Algorithm":"LATEST_WITHIN_WINDOW","IncludeVaults":["*"],"RecoveryPointTypes":["SNAPSHOT"],"SelectionWindowDays":7}}' \
  --region "$REGION" >/dev/null || fail "OOB update-restore-testing-plan"

echo "=== [$STACK] OOB mutate: RUM SessionSampleRate 0.1->0.5 ==="
aws rum update-app-monitor --name "$RUM_NAME" \
  --app-monitor-configuration '{"SessionSampleRate":0.5}' \
  --region "$REGION" >/dev/null || fail "OOB update-app-monitor"
sleep 15

$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.mut.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "MISSED DETECTION: expected exit 1 after OOB mutations (got $rc)"

echo "=== [$STACK] revert + live convergence ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.rev.out" || fail "revert errored"
sleep 15

LIVE_SWD="$(aws backup get-restore-testing-plan --restore-testing-plan-name "$RTP_NAME" --region "$REGION" \
  --query 'RestoreTestingPlan.RecoveryPointSelection.SelectionWindowDays' --output text)"
[ "$LIVE_SWD" = "30" ] || fail "REVERT NO-OP (RTP): live SelectionWindowDays=$LIVE_SWD (expected 30) — RSDP candidate"

LIVE_SSR="$(aws rum get-app-monitor --name "$RUM_NAME" --region "$REGION" \
  --query 'AppMonitor.AppMonitorConfiguration.SessionSampleRate' --output text)"
[ "$LIVE_SSR" = "0.1" ] || fail "REVERT NO-OP (RUM): live SessionSampleRate=$LIVE_SSR (expected 0.1) — RSDP candidate"

$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG PASS ($STACK)"

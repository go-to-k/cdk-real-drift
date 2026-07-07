#!/usr/bin/env bash
# cdk-real-drift SLO + CodeStar NotificationRule false-positive integration test
# (real AWS, bug hunt). Deploys an ApplicationSignals ServiceLevelObjective (Goal +
# Description omitted so AWS fills defaults undeclared) and a CodeStarNotifications
# NotificationRule. Strong assertion: with NO baseline, `check --fail` must exit 0 —
# every AWS-assigned undeclared default must fold to atDefault, and no declared value
# may surface as drift. Then record + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# Usage:  cd tests/integration/slo-notif-rich && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSloNotif
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== corpus harvest (fresh, no baseline) ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-/tmp/corpus-slo-notif}" $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true

echo "=== check --fail (no baseline) must find ZERO potential drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-slo-notif-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "potential drift on a clean fresh deploy (exit $rc) — a fold gap"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS"

#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test wave 6 (real AWS) — R84.
#
# Common, cheap, currently-uncovered CFn types (corpus had 93 distinct types as
# of R83): ECS TaskDefinition (Fargate), CodeBuild Project, WAFv2 IPSet +
# RuleGroup, SSM MaintenanceWindow + PatchBaseline, Lambda FunctionUrl, Cognito
# UserPoolGroup, EC2 LaunchTemplate + PrefixList, ApiGateway UsagePlan + ApiKey,
# EventBridge Pipes Pipe. Asserts the two harvest invariants:
#   1. baseline-free `check` — fresh deploy = ZERO declared drift, exit 0;
#   2. `record --yes` then `check --fail` — CLEAN across every type.
#
# CDKRD_HARVEST6_KEEP=1 skips the destroy for debug iteration.
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest6 && npm install && bash verify-harvest6.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdIntegHarvest6
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest6.out

cleanup() {
  if [ -n "${CDKRD_HARVEST6_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_HARVEST6_KEEP set) — destroy manually when done ---"
    return
  fi
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (wave 6: uncovered common types) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== 1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "CFn-Declared Drift" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== 2. record + check --fail must be CLEAN across every type ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS"

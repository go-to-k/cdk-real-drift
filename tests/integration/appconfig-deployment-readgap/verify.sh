#!/usr/bin/env bash
# FP oracle + read-gap regression: deploy -> record -> check MUST be CLEAN, and the
# 3-segment composite-id types (HostedConfigurationVersion, Deployment) must be READ
# (not CC-skipped).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAppconfigDeploymentReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE ---"; fail "expected CLEAN got $rc"; }
echo "=== composite types MUST be READ (not skipped) ==="
$CLI check "$STACK" --region "$REGION" --verbose 2>&1 | grep -qE "Skipped.*(HostedConfigurationVersion|Deployment)" \
  && fail "a 3-segment composite type is still skipped (read-gap)" || echo "(no composite skip — read-gap closed)"
echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# Grafana Workspace detect + revert integration test (real AWS): the "someone edited
# the workspace in the console" scenario. Deploy -> record -> change the DECLARED
# MUTABLE Description out of band -> check MUST DETECT (exit 1) -> revert -> check MUST
# be CLEAN and Description restored. Verified live on hunt 2026-07-07 (revert via
# Cloud Control UpdateResource; the workspace is FULLY_MUTABLE).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegGrafanaRich
NAME=cdkrd-grafana-rich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

WSID="$(aws grafana list-workspaces --region "$REGION" --query "workspaces[?name=='$NAME'].id" --output text)"
[ -n "$WSID" ] && [ "$WSID" != "None" ] || fail "could not resolve workspace id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change Description (console-edit) ==="
aws grafana update-workspace --workspace-id "$WSID" --region "$REGION" \
  --workspace-description "MUTATED-OOB" >/dev/null || fail "inject drift"
# wait for the workspace to settle back to ACTIVE
until [ "$(aws grafana describe-workspace --workspace-id "$WSID" --region "$REGION" --query 'workspace.status' --output text)" = "ACTIVE" ]; do sleep 5; done

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-grafana-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "Description" /tmp/cdkrd-grafana-detect.out || fail "Description not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
until [ "$(aws grafana describe-workspace --workspace-id "$WSID" --region "$REGION" --query 'workspace.status' --output text)" = "ACTIVE" ]; do sleep 5; done

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live Description MUST be restored ==="
GOT="$(aws grafana describe-workspace --workspace-id "$WSID" --region "$REGION" --query 'workspace.description' --output text)"
[ "$GOT" = "cdkrd grafana rich" ] || fail "live Description not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

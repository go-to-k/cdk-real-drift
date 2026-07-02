#!/usr/bin/env bash
# Missed-detection (FN) integration test (real AWS): with the aps-rich stack
# DEPLOYED and RECORDED (run by verify.sh first, or standalone), mutate the
# mutable APS Workspace Alias out of band -> `check --fail` MUST detect (exit 1)
# -> `revert --yes` MUST restore the declared alias -> `check --fail` MUST be
# CLEAN again. Run while the stack is still up; does NOT deploy or clean up.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApsRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
fail() { echo "INTEG FAIL ($STACK detect): $*"; exit 1; }

WS_ID=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkspaceId'].OutputValue" --output text)
[ -n "$WS_ID" ] || fail "could not resolve WorkspaceId output"

echo "=== [$STACK] mutate Workspace Alias out of band (workspace $WS_ID) ==="
aws amp update-workspace-alias --workspace-id "$WS_ID" --alias "cdkrd-hunt-aps-DRIFTED" --region "$REGION" || fail "mutate alias"

echo "=== [$STACK] check MUST detect the alias drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detection (exit 1), got $rc"
grep -q "Alias" "/tmp/cdkrd-$STACK-detect.out" || fail "drift output does not mention Alias"

echo "=== [$STACK] revert MUST restore the declared alias ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE_ALIAS=$(aws amp describe-workspace --workspace-id "$WS_ID" --region "$REGION" --query 'workspace.alias' --output text)
[ "$LIVE_ALIAS" = "cdkrd-hunt-aps" ] || fail "live alias not restored (got $LIVE_ALIAS)"

echo "INTEG PASS ($STACK detect)"

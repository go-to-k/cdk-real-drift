#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy a classic ELB, then a FIRST
# `check` BEFORE `record` MUST be CLEAN (core invariant: zero [Potential Drift] on a
# clean, un-mutated deploy). Then record -> check MUST also be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElbClassicRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== first check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
rc=$?; [ "$rc" -eq 0 ] || fail "expected first-check CLEAN got $rc"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail
rc=$?; [ "$rc" -eq 0 ] || fail "expected CLEAN got $rc"
echo "INTEG PASS ($STACK)"

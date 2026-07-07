#!/usr/bin/env bash
# FP integration test: deploy -> check BEFORE record (fresh potential-drift oracle) ->
# record -> check MUST be CLEAN. IVS Channel: schema-annotated defaults fold; the oracle
# targets non-annotated undeclared echoes (Preset, MultitrackInputConfiguration).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIvsChannelRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="
npx cdk deploy -f "$STACK" --require-approval never >/tmp/ivs-deploy.log 2>&1 || { tail -30 /tmp/ivs-deploy.log; fail "deploy"; }
echo "=== check BEFORE record (oracle) ==="
$CLI check "$STACK" --region "$REGION" --verbose | tee "/tmp/ivs-fresh.out"
echo "=== harvest corpus ==="
rm -rf /tmp/corpus-ivs; CDKRD_CORPUS_DIR="/tmp/corpus-ivs" $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true
echo "=== record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/ivs.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on clean recorded stack ---"; fail "expected CLEAN, got $rc"; }
echo "INTEG PASS ($STACK)"

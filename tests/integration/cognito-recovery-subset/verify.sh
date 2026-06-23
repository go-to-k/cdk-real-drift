#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegCognitoRecoverySubset; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== [$STACK] deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
echo "=== [$STACK] pre-record check (harvest + triage) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-$STACK" $CLI check "$STACK" --region "$REGION" --verbose 2>&1 | tee "/tmp/cdkrd-prerecord-$STACK.out" || true
echo "=== [$STACK] record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== [$STACK] check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail 2>&1 | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK ---"; fail "expected CLEAN, got $rc"; }
echo "INTEG PASS ($STACK)"

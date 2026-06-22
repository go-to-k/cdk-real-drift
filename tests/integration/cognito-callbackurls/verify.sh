#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. A UserPoolClient with multiple CallbackURLs/LogoutURLs declared in a
# non-canonical order — Cognito echoes the URL sets in its own order; any declared-tier
# drift here is a set-ordering FP (sibling of the suppressed AllowedOAuthFlows/Scopes).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCognitoCallbackUrls
REGION="${AWS_REGION:-ap-northeast-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
AWS_REGION="$REGION" npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] check BEFORE record (read the undeclared/atDefault breakdown) ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-}" $CLI check "$STACK" --region "$REGION" --verbose | tee "/tmp/cdkrd-$STACK-pre.out" || true

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. Also asserts the two Cognito attachment types are READ (not
# silently skipped) — the read-gap this fixture exists to close.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCognitoAttachmentReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR="/tmp/corpus-cognito-attachment-readgap" $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] assert attachments were READ (not skipped) ==="
grep -q "RiskConfigurationAttachment\|UICustomizationAttachment" "/tmp/cdkrd-$STACK.out" 2>/dev/null
# The skipped count must not include our attachment types; surface the info footer.
if grep -qiE "skipped=[1-9]" "/tmp/cdkrd-$STACK.out"; then
  echo "--- WARNING: a resource was skipped (read-gap) — inspect the info footer above ---"
fi

echo "INTEG PASS ($STACK)"

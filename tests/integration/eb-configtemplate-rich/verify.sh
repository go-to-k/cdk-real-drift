#!/usr/bin/env bash
# Zero-potential-drift invariant test (real AWS): deploy two EB ConfigurationTemplates
# (SingleInstance + LoadBalanced) and assert a `check` BEFORE record is already CLEAN —
# AWS materializes the full ~50-80 option set from the 1 declared option, and every
# service-filled extra MUST fold to atDefault (equality-gate / derive-from-EnvironmentType /
# value-independent). A ConfigurationTemplate provisions NOTHING, so this is cheap + fast.
# Any [Potential Drift] on the fresh templates is a fold gap (a bug).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEbConfigTemplate
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

if [ -n "${CDKRD_CORPUS_DIR:-}" ]; then
  echo "=== [$STACK] harvest corpus (pre-record) ==="
  $CLI check "$STACK" --region "$REGION" || true
fi

echo "=== [$STACK] check BEFORE record MUST be CLEAN (every filled option folds to atDefault) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-pre.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK potential drift on fresh templates ---"; fail "expected CLEAN before record (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

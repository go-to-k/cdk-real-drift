#!/usr/bin/env bash
# Zero-potential-drift invariant test (real AWS) across EB platforms + an Environment read:
#   - ConfigurationTemplates on Python / Node.js / Corretto / PHP (platform-specific option
#     defaults must fold — the tables were originally pinned only from Docker).
#   - A Docker SingleInstance Environment whose OptionSettings is read back via the
#     DescribeConfigurationSettings SDK supplement (was a writeOnly readGap); its declared
#     options are verified and the service-filled extras fold.
# A `check` BEFORE record MUST be CLEAN — any [Potential Drift] is a fold gap. NOTE: this
# fixture deploys a real Environment (one t3.micro, ~5 min), so it is not cheap.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEbPlatforms
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

echo "=== [$STACK] check BEFORE record MUST be CLEAN (every platform + env option folds) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-pre.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK potential drift on fresh templates/env ---"; fail "expected CLEAN before record (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

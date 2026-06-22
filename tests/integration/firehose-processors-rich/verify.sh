#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy a Firehose DirectPut->S3
# stream with a Lambda Processor whose Parameters array is declared in
# NON-canonical order -> record baseline -> check MUST be CLEAN. Firehose
# Processors[].Parameters ({ParameterName,ParameterValue}, ParameterName not an
# identity field, nested under Processors) is in no noise.ts fold table; if
# Firehose returns the set reordered, a positional diff false-flags declared
# drift. Cheap: S3 + Lambda + IAM, no VPC.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegFirehoseProcessorsRich
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

echo "=== [$STACK] check BEFORE record (raw classification + corpus harvest) ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR:-/tmp/corpus-firehose-processors-rich}" \
  $CLI check "$STACK" --region "$REGION" --verbose | tee "/tmp/cdkrd-$STACK.pre.out" || true

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

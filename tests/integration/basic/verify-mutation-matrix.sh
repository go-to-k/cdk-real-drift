#!/usr/bin/env bash
# cdk-real-drift mutation-matrix integration test (real AWS) — R64.
#
# False-NEGATIVE coverage: after a full record (snapshot-complete baseline),
# walk one resource through every drift DIRECTION the model distinguishes and
# assert each one is detected, named, and resolvable back to CLEAN:
#
#   M1 declared-change    versioning Enabled -> Suspended   resolve: revert
#   M2 undeclared-add     acceleration appears (R62:        resolve: record
#                         "appeared since record" on a
#                         snapshot-complete resource)
#   M3 undeclared-change  recorded acceleration value flips resolve: record
#   M4 undeclared-add     out-of-band CORS config appears   resolve: record
#   M5 value-remove       recorded CORS deleted ->          resolve: record
#                         "baseline value removed since record"
#
# M4/M5 use CORS, not tags (first live run, R68): put-bucket-tagging REPLACES
# the whole TagSet and S3 refuses to drop the CFn-applied aws:* system tags
# ("System tags cannot be removed by requester") — CORS has no system-managed
# entries to collide with.
#
# Each mutation ends back at CLEAN, so the matrix also exercises the record
# delta loop (R39) and the declared revert path once. Reuses the `basic`
# fixture/stack; run sequentially with the other basic scripts, never
# concurrently. Tip: CDKRD_CORPUS_DIR=/tmp/corpus records every check here as
# golden-corpus cases (R63) — fictional names, safe to commit.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/basic && npm install && bash verify-mutation-matrix.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkdriftIntegBasic
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
SLEEP="${CDKRD_INTEG_SLEEP:-5}"
OUT=/tmp/cdkrd-mutation-matrix.out

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

# check must exit 1 AND the output must name every given pattern
expect_drift() {
  local name="$1"; shift
  sleep "$SLEEP"
  $CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 1 ] || fail "$name: expected drift exit 1, got $rc"
  for pattern in "$@"; do
    grep -q "$pattern" "$OUT" || fail "$name: expected output to name: $pattern"
  done
}

expect_clean() {
  local name="$1"
  sleep "$SLEEP"
  $CLI check "$STACK" --region "$REGION" --fail \
    || fail "$name: expected CLEAN (exit 0) after resolving"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "could not resolve bucket physical id"

echo "=== full record (snapshot-complete baseline) + CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
expect_clean "baseline"

echo "=== M1 declared-change: suspend versioning (template says Enabled) ==="
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Suspended --region "$REGION" || fail "M1 inject"
expect_drift "M1" "DECLARED DRIFT" "VersioningConfiguration"
$CLI revert "$STACK" --region "$REGION" --yes || fail "M1 revert"
expect_clean "M1"

echo "=== M2 undeclared-add: acceleration appears after a complete record (R62) ==="
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" \
  --accelerate-configuration Status=Enabled --region "$REGION" || fail "M2 inject"
expect_drift "M2" "UNDECLARED DRIFT" "AccelerateConfiguration" "appeared since record"
$CLI record "$STACK" --region "$REGION" --yes || fail "M2 record"
expect_clean "M2"

echo "=== M3 undeclared-change: recorded acceleration value flips ==="
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" \
  --accelerate-configuration Status=Suspended --region "$REGION" || fail "M3 inject"
expect_drift "M3" "UNDECLARED DRIFT" "AccelerateConfiguration"
$CLI record "$STACK" --region "$REGION" --yes || fail "M3 record"
expect_clean "M3"

echo "=== M4 undeclared-add: out-of-band CORS configuration ==="
aws s3api put-bucket-cors --bucket "$BUCKET" --region "$REGION" --cors-configuration \
  '{"CORSRules":[{"AllowedMethods":["GET"],"AllowedOrigins":["https://example.com"]}]}' \
  || fail "M4 inject"
expect_drift "M4" "UNDECLARED DRIFT" "CorsConfiguration" "appeared since record"
$CLI record "$STACK" --region "$REGION" --yes || fail "M4 record"
expect_clean "M4"

echo "=== M5 value-remove: the recorded CORS configuration disappears ==="
aws s3api delete-bucket-cors --bucket "$BUCKET" --region "$REGION" || fail "M5 inject"
expect_drift "M5" "UNDECLARED DRIFT" "CorsConfiguration" "baseline value removed since record"
$CLI record "$STACK" --region "$REGION" --yes || fail "M5 record"
expect_clean "M5"

echo "INTEG PASS"

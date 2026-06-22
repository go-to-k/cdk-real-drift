#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. An MSK *provisioned* Cluster (AWS::MSK::Cluster) declares a
# KafkaVersion ("3.6.0") — unlike the msk-serverless fixture, which has none. MSK
# validates KafkaVersion against the exact supported-version list and echoes the
# literal string back, so declared == live and the "partial -> concrete version"
# FP class (RDS-style "8.0" -> "8.0.45") is NOT reproducible here; this is a
# baseline clean-check for the provisioned Cluster type. See app.ts for the full
# determination.
#
# NOTE: deploy is SLOW (~30 min) and provisions billed brokers (kafka.t3.small x2
# with EBS). The cleanup trap delstack-deletes the cluster + VPC on exit.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMskCluster
REGION="${AWS_REGION:-ap-northeast-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture (SLOW: ~30 min, broker-billed) ==="
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

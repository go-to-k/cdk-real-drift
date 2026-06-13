#!/usr/bin/env bash
# cdk-real-drift false-positive ("noise") integration test (real AWS, R87).
#
# Deploys resources that DECLARE properties whose live AWS form is textually
# different but semantically equal (IAM policy with an aws:SecureTransport
# condition, multi-action statements, a managed policy by name; resource tags AWS
# augments with aws:cloudformation:* and reorders; S3 CORS rules). If any
# normalizer regresses, one of these declared values diverges from live and is
# reported as a FALSE declared drift.
#
# The assertion is the strong one: WITHOUT any baseline, `check --fail` must exit
# 0 — there is no declared drift to find, because every declared value normalizes
# equal to live. (Undeclared/at-default values are not drift and never fail.) Then
# accept + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/noise && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegNoise
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

# The core false-positive guard: with NO baseline, the only thing `--fail` can flag
# is DECLARED drift, and there must be none — every tricky declared value (policy
# with aws:SecureTransport, multi-action statements, name<->ARN managed policy,
# tags AWS augments + reorders, CORS rules) must normalize equal to live.
echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-noise-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift on a noise-prone property (exit $rc) — a normalizer regressed"
grep -q "DECLARED DRIFT" /tmp/cdkrd-noise-pre.out \
  && fail "a declared property was wrongly reported as drift (false positive)"

echo "=== accept then check must stay CLEAN ==="
$CLI accept "$STACK" --region "$REGION" --yes || fail "accept"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after accept"

echo "INTEG PASS"

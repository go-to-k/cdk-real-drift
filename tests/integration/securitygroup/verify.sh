#!/usr/bin/env bash
# cdk-real-drift SecurityGroup false-positive integration test (real AWS, R88).
#
# Deploys resources that DECLARE noise-prone properties (see app.ts) whose live AWS
# form is textually different but semantically equal. The strong assertion: with NO
# baseline, `check --fail` must exit 0 — there is no declared drift, because every
# declared value normalizes equal to live. A normalizer regression turns one into a
# false declared drift and fails here. Then record + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# Usage:  cd tests/integration/securitygroup && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSg
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-securitygroup-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "false declared drift on a noise-prone property (exit $rc) — a normalizer regressed"
grep -q "CFn-Declared Drift" /tmp/cdkrd-securitygroup-pre.out \
  && fail "a declared property was wrongly reported as drift (false positive)"
# The SG declares no GroupName, so CFn mints one (<stack>-<logicalId>-<random>). It must fold
# as `generated`, NOT surface as undeclared potential-drift noise on the first run.
grep -q "GroupName" /tmp/cdkrd-securitygroup-pre.out \
  && fail "auto-generated GroupName surfaced as potential drift (should fold as generated)"
# CC mis-echoes the IGW gateway id into a public route's VpcEndpointId, and echoes the
# resolved AvailabilityZoneId for each subnet's declared AvailabilityZone — both common VPC
# first-run noise that must be dropped, not surfaced.
grep -q "VpcEndpointId" /tmp/cdkrd-securitygroup-pre.out \
  && fail "Route VpcEndpointId (CC echoing the gateway id) surfaced — should be dropped"
grep -q "AvailabilityZoneId" /tmp/cdkrd-securitygroup-pre.out \
  && fail "Subnet AvailabilityZoneId (alt form of declared AvailabilityZone) surfaced — should be dropped"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS"

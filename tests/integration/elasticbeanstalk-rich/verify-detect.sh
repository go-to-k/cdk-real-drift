#!/usr/bin/env bash
# Missed-detection (FN) integration test (real AWS): with the elasticbeanstalk-rich
# stack DEPLOYED and RECORDED (run by verify.sh first, or standalone), mutate the
# declared mutable Application Description out of band -> `check --fail` MUST detect
# (exit 1) -> `revert --yes` MUST restore the declared Description -> `check --fail`
# MUST be CLEAN again. Run while the stack is still up; does NOT deploy or clean up.
#
# Note: Cloud Control's UpdateResource on an EB Application echoes a spurious
# "Parameter ServiceRole is invalid" error even though the Description patch applies,
# so the revert prints a FAILED line but converges (the post-revert re-read confirms
# CLEAN). The assertion below is on the converged live value, not the revert message.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEbRich
REGION="${AWS_REGION:-us-east-1}"
APP=cdkrd-hunt-eb-app
DECLARED_DESC="cdkrd bug-hunt Elastic Beanstalk application"
CLI="node $ROOT/dist/cli.js"
fail() { echo "INTEG FAIL ($STACK detect): $*"; exit 1; }

echo "=== [$STACK] mutate Application Description out of band ==="
aws elasticbeanstalk update-application --application-name "$APP" \
  --description "DRIFTED-out-of-band" --region "$REGION" >/dev/null || fail "mutate description"

echo "=== [$STACK] check MUST detect the declared Description drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detection (exit 1), got $rc"
grep -q "Description" "/tmp/cdkrd-$STACK-detect.out" || fail "drift output does not mention Description"

echo "=== [$STACK] revert (converges despite the CC ServiceRole message) ==="
$CLI revert "$STACK" --region "$REGION" --yes || true

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE_DESC=$(aws elasticbeanstalk describe-applications --application-names "$APP" \
  --region "$REGION" --query 'Applications[0].Description' --output text)
[ "$LIVE_DESC" = "$DECLARED_DESC" ] || fail "live description not restored (got $LIVE_DESC)"

echo "INTEG PASS ($STACK detect)"

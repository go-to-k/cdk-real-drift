#!/usr/bin/env bash
# cdk-real-drift `added` integ test for CloudWatch Logs (the EIGHTH CHILD_ENUMERATORS member).
#   deploy fixture (a LogGroup + one declared MetricFilter) -> record -> CLEAN
#   -> put-metric-filter an undeclared filter on the SAME log group out of band -> check
#      reports the filter under [Not Recorded] and is NOT drift (exit 0) -> `record`
#      snapshots it (proves CC GetResource on the composite LogGroupName|FilterName) -> CLEAN
#   -> add ANOTHER out-of-band filter -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; deleting a LogGroup CASCADES its metric filters, so there is no
# stack-external orphan and no per-filter sweep is needed (the LogGroup uses RemovalPolicy
# DESTROY in app.ts — CDK would otherwise RETAIN it).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/logs-metricfilter-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLogsMetricFilterAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_filter() { # $1 = filter name -> puts a metric filter on the log group
  aws logs put-metric-filter --log-group-name "$LG" --filter-name "$1" \
    --filter-pattern '"oob"' \
    --metric-transformations metricName=Oob,metricNamespace=cdkrd/integ,metricValue=1 \
    --region "$REGION" >/dev/null || fail "put-metric-filter $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

LG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)"
[ -n "$LG" ] || fail "could not resolve LogGroup name"

echo "=== put an undeclared metric filter on the log group out of band ==="
inject_filter cdkrd-integ-oob-record

echo "=== check reports the filter as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-lmf.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-lmf.out || fail "added filter not under [Not Recorded]"
grep -q "AWS::Logs::MetricFilter" /tmp/cdkrd-integ-lmf.out || fail "the out-of-band filter not reported"
grep -q "added=" /tmp/cdkrd-integ-lmf.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added filter (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite identifier) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-lmf-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added filter, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-lmf-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band filter for the revert path ==="
inject_filter cdkrd-integ-oob-revert

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-lmf-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-lmf-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-lmf-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-lmf-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second filter must be gone from AWS ==="
remaining="$(aws logs describe-metric-filters --log-group-name "$LG" \
  --filter-name-prefix cdkrd-integ-oob-revert --region "$REGION" \
  --query "metricFilters" --output text 2>/dev/null)"
[ -z "$remaining" ] || fail "the reverted filter still exists (delete did not take effect)"

echo "INTEG PASS"

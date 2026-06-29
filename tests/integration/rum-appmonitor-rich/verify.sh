#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. A CloudWatch RUM AppMonitor carries several SET-like lists
# (Telemetries / ExcludedPages / IncludedPages / FavoritePages) declared
# non-sorted; if RUM echoes them reordered, a positional compare would false-drift
# them. Any declared drift on a clean recorded stack is a normalization FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRumRich
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

# Regression for the --show-all first-run false-drift bug: with NO baseline,
# inventory mode EXPANDS every live-only value (folded into the `info:` footer
# without --show-all) but they are informational inventory — Potential Drift OR At
# AWS Default — NOT confirmed drift, so `check --show-all --fail` MUST exit 0 (not
# flag the fresh deploy's undeclared inventory as drift and fail CI). The monitor's
# live-only values (Platform / DeobfuscationConfiguration) currently both fold to At
# AWS Default, so assert the inventory tier is EXPANDED (either label), not the
# Potential Drift label specifically (which other fixtures cover).
echo "=== [$STACK] check --show-all --fail (no baseline) MUST be exit 0 ==="
rm -rf .cdkrd
$CLI check "$STACK" --region "$REGION" --show-all --fail | tee "/tmp/cdkrd-$STACK-showall.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "--show-all --fail must not flag first-run inventory as drift (got exit $rc)"
grep -qE "\[(Potential Drift|At AWS Default):" "/tmp/cdkrd-$STACK-showall.out" || fail "--show-all did not expand the live-only inventory"
# the plain check (no --show-all) folds the inventory into the info footer — confirm
# --show-all is what expanded it (else the assertion above is not testing --show-all)
$CLI check "$STACK" --region "$REGION" | grep -qE "\[At AWS Default:" && fail "inventory expanded WITHOUT --show-all (assertion no longer specific to --show-all)"
grep -q "drift(s)" "/tmp/cdkrd-$STACK-showall.out" && fail "--show-all mislabeled first-run inventory as confirmed drift"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

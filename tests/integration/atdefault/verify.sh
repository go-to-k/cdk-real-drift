#!/usr/bin/env bash
# cdk-real-drift `atDefault` integration test (real AWS, R87).
#
# Validates the R86 fold end-to-end against a live account:
#   1. a default-config Lambda + a bare L1 S3 bucket carry undeclared properties
#      that sit at a known AWS default;
#   2. BEFORE any baseline, those values FOLD into the atDefault tier (they are
#      NOT listed in the report body) — this proves the hand-written KNOWN_DEFAULTS
#      shapes (esp. the S3 BucketEncryption shape with BlockedEncryptionTypes)
#      actually match what Cloud Control returns today. A shape mismatch would
#      reclassify the value as real undeclared and surface it in the body — caught
#      here as a failure;
#   3. `--show-all` expands the fold and lists those same values under AT AWS DEFAULT;
#   4. the equality gate has teeth: mutate one at-default value AWAY from its
#      default out of band and `check` MUST surface it as real drift (the fold
#      never blinds cdkrd to an actual change).
#
# A cleanup trap destroys + removes the baseline even on failure, so a failed run
# leaves no orphan resources.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/atdefault && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAtDefault
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

# ---- 2: before any baseline, at-default values FOLD (not listed in the body) ----
echo "=== check (no baseline): at-default values must be FOLDED, not in the body ==="
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-atdef-fold.out
grep -q "atDefault=" /tmp/cdkrd-atdef-fold.out || fail "no atDefault fold count in the info: footer"
# These sit at their AWS default, so they must NOT appear as listed undeclared
# values. If a KNOWN_DEFAULTS shape no longer matches live, the value reclassifies
# to real undeclared and shows up here — that is the bug this assertion catches.
for p in PublicAccessBlockConfiguration BucketEncryption OwnershipControls TracingConfig; do
  grep -q "$p" /tmp/cdkrd-atdef-fold.out \
    && fail "$p is at its AWS default but was listed in the body (KNOWN_DEFAULTS shape drift?)"
done

# ---- 3: --show-all expands the fold and lists them under AT AWS DEFAULT ----
echo "=== check --show-all: the folded values must appear under AT AWS DEFAULT ==="
$CLI check "$STACK" --region "$REGION" --show-all | tee /tmp/cdkrd-atdef-showall.out
grep -q "AT AWS DEFAULT" /tmp/cdkrd-atdef-showall.out || fail "no AT AWS DEFAULT section under --show-all"
for p in PublicAccessBlockConfiguration BucketEncryption TracingConfig; do
  grep -q "$p" /tmp/cdkrd-atdef-showall.out || fail "$p missing from the --show-all inventory"
done

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN right after record (at-default values fold, not drift) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

# ---- 4: the equality gate has teeth — mutate an at-default value away from default ----
echo "=== mutate Lambda TracingConfig PassThrough -> Active (out of band) ==="
FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"
aws lambda update-function-configuration --function-name "$FN_NAME" \
  --tracing-config Mode=Active --region "$REGION" >/dev/null || fail "inject TracingConfig drift"
# the update is async; wait for it to settle before reading back
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true
sleep 5

echo "=== check must now DETECT the changed value (fold never hides a real change) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-atdef-drift.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 after mutating TracingConfig, got $rc"
grep -q "TracingConfig" /tmp/cdkrd-atdef-drift.out || fail "TracingConfig change not reported"
grep -q "Active" /tmp/cdkrd-atdef-drift.out || fail "the changed value (Active) not in the report"

echo "INTEG PASS"

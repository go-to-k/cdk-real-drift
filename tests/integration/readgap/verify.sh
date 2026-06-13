#!/usr/bin/env bash
# cdk-real-drift "honest gap" integration test (real AWS, R87).
#
# A declared write-only property (SecretsManager SecretString) cannot be read back
# from AWS. A change to it out of band is real drift cdkrd CANNOT verify — and the
# design promise is to report that honestly as a `readGap`, never to silently pass
# it as CLEAN (which would make the user blind to it). This asserts the write-only
# value surfaces in the readGap tier, with a `write-only` reason.
#
# The cleanup trap force-deletes the secret (no 30-day recovery-window residue).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/readgap && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegReadGap
REGION="${AWS_REGION:-us-east-1}"
SECRET=cdkrd-integ-readgap
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  # purge the secret immediately (cdk destroy only SCHEDULES deletion)
  aws secretsmanager delete-secret --secret-id "$SECRET" \
    --force-delete-without-recovery --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

# The write-only SecretString must be reported as a readGap, not silently dropped.
echo "=== the write-only SecretString must surface as a readGap (honest gap) ==="
$CLI check "$STACK" --region "$REGION" --verbose | tee /tmp/cdkrd-readgap.out
grep -qi "write-only" /tmp/cdkrd-readgap.out \
  || fail "the write-only SecretString was not surfaced as a readGap — silently dropped?"
grep -q "SecretString" /tmp/cdkrd-readgap.out \
  || fail "the readGap does not name the SecretString property"

# A readGap is informational, not drift: --fail must still exit 0 (it is NOT a
# false positive), and the secret value being unverifiable must NOT read as CLEAN
# silence — the readGap above is the honest signal.
echo "=== readGap is informational: --fail exits 0 (not a false positive) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "a write-only readGap must not fail the build (it is not drift)"

echo "INTEG PASS"

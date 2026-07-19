#!/usr/bin/env bash
# False-positive integration test (real AWS), TWO-PHASE: CloudFront rejects a
# ContinuousDeploymentPolicyId at distribution creation, so deploy without it first,
# then redeploy with `-c attach=1` to attach the policy via UPDATE. Both phases must
# show ZERO [Potential Drift] on a pre-record check (phase 2 doubles as a post-update
# echo probe), then record -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0720CfCd
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] phase 1: deploy without the policy attachment ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy phase 1"

echo "=== [$STACK] phase 1 check (pre-record): every [Potential Drift] is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.p1.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.p1.out" && fail "phase-1 first check must show zero [Potential Drift]"

echo "=== [$STACK] phase 2: attach the continuous-deployment policy via UPDATE ==="
npx cdk deploy -f "$STACK" -c attach=1 --require-approval never || fail "deploy phase 2 (attach)"

echo "=== [$STACK] phase 2 check (post-update echo probe, corpus harvest) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-cfcd $CLI check "$STACK" --region "$REGION" -c attach=1 | tee "/tmp/cdkrd-$STACK.p2.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.p2.out" && fail "phase-2 check must show zero [Potential Drift] (post-update echo)"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" -c attach=1 --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" -c attach=1 --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

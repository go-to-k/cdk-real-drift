#!/usr/bin/env bash
# EB arm64 default-instance-types variant probe: resolve the latest Docker
# AL2023 solution stack, deploy an arm64 SingleInstance env with NO instance
# types declared, first check MUST be CLEAN (the docs-pinned t4g.micro/t4g.small
# row is unproven live).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722EbArm
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

EB_STACK="$(aws elasticbeanstalk list-available-solution-stacks --region "$REGION" \
  --query "SolutionStacks[?contains(@, 'Amazon Linux 2023') && contains(@, 'running Docker')] | [0]" --output text)"
[ -n "$EB_STACK" ] && [ "$EB_STACK" != "None" ] || { echo "INTEG FAIL ($STACK): no AL2023 Docker solution stack"; exit 1; }
export EB_STACK
echo "using solution stack: $EB_STACK"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-ebarm}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "INTEG PASS ($STACK)"

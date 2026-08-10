#!/usr/bin/env bash
# Barest first-run FP probe on the 2026-08-11 hunt pack (two stacks): deploy,
# assert the FIRST check (before record) is CLEAN — every [Potential Drift] /
# false `added` entry it prints is a fold/suppression gap to triage — then
# record and assert check --fail stays clean. Finally the post-update echo
# probe: redeploy with -c rev=2 (neutral tag update) and re-check.
#
# The KMS ReplicaKey leg needs a multi-Region PRIMARY key in another region:
# created here via CLI (us-west-2), threaded in with -c primaryKeyArn=..., and
# scheduled for deletion (7-day pending) in the cleanup trap.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACKS=(CdkrdHunt0811BarestA CdkrdHunt0811BarestB)
REGION="${AWS_REGION:-us-east-1}"
KMS_PRIMARY_REGION="us-west-2"
CLI="node $ROOT/dist/cli.js"

PRIMARY_KEY_ARN=""

cleanup() {
  echo "--- cleanup (${STACKS[*]}) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  if [ -n "$PRIMARY_KEY_ARN" ]; then
    aws kms schedule-key-deletion --key-id "$PRIMARY_KEY_ARN" \
      --pending-window-in-days 7 --region "$KMS_PRIMARY_REGION" >/dev/null 2>&1 || true
  fi
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (barest5-hunt): $*"; exit 1; }

echo "=== create multi-Region primary key ($KMS_PRIMARY_REGION) ==="
PRIMARY_KEY_ARN=$(aws kms create-key --multi-region \
  --description "cdkrd barest5-hunt primary (ephemeral)" \
  --tags TagKey=cdkrd:ephemeral,TagValue=1 \
  --region "$KMS_PRIMARY_REGION" --query 'KeyMetadata.Arn' --output text) || fail "create primary key"
echo "primary: $PRIMARY_KEY_ARN"

echo "=== deploy (both stacks) ==="
npx cdk deploy -f --all --require-approval never -c "primaryKeyArn=$PRIMARY_KEY_ARN" || fail "deploy"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
  CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-barest5}" $CLI check "$STACK" --region "$REGION" --fail \
    -c "primaryKeyArn=$PRIMARY_KEY_ARN" | tee "/tmp/cdkrd-$STACK.pre.out"
  RC=${PIPESTATUS[0]}
  # `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
  # A false `added` on the inline-subscription topic is the #1729-class bug this
  # fixture probes — count added-tier entries too.
  grep -qE "created out of band|\[Added\]" "/tmp/cdkrd-$STACK.pre.out" && RC=11
  [ "$RC" -eq 0 ] || fail "[$STACK] first check not clean (rc=$RC)"

  echo "=== [$STACK] record + check --fail ==="
  $CLI record "$STACK" --region "$REGION" --yes -c "primaryKeyArn=$PRIMARY_KEY_ARN" || fail "[$STACK] record"
  $CLI check "$STACK" --region "$REGION" --fail -c "primaryKeyArn=$PRIMARY_KEY_ARN" || fail "[$STACK] post-record check not clean"
done

echo "=== redeploy with -c rev=2 (post-update echo probe) ==="
npx cdk deploy -f --all --require-approval never -c rev=2 -c "primaryKeyArn=$PRIMARY_KEY_ARN" || fail "redeploy rev=2"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] post-update check MUST be CLEAN ==="
  $CLI check "$STACK" --region "$REGION" --fail -c "primaryKeyArn=$PRIMARY_KEY_ARN" | tee "/tmp/cdkrd-$STACK.rev2.out"
  RC=${PIPESTATUS[0]}
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.rev2.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] post-update check not clean (rc=$RC)"
done

echo "INTEG OK (barest5-hunt)"

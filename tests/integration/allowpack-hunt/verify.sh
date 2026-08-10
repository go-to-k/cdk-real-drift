#!/usr/bin/env bash
# 2026-08-10 hunt: allowlist-gap first-run FP probe.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0810Allow
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN (allowlist-gap FP probe) ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-allowpack}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see /tmp/cdkrd-$STACK.pre.out)"

echo "=== [$STACK] record -> check --fail MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check"

echo "=== [$STACK] RecordSetGroup member detect/revert (#1743) ==="
# pre-#1743 the group was wholly `skipped` (no CC read handler) — an OOB member change
# was invisible. Mutate the mixed-case member's TTL out of band -> the group reader
# must DETECT it as declared drift -> revert (per-member ChangeResourceRecordSets
# UPSERT) -> clean -> live TTL restored.
ZONE_ID="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id Zone --query 'StackResourceDetail.PhysicalResourceId' --output text)"
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch \
  '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"mixed-case.cdkrd-fphunt-a0810.com.","Type":"A","TTL":60,"ResourceRecords":[{"Value":"192.0.2.1"}]}}]}' \
  >/dev/null || fail "mutate rsg member TTL"
sleep 15
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected RSG member drift (exit 1)"
grep -q "Records.RecordSets" "/tmp/cdkrd-$STACK.detect.out" || fail "missed RSG member detection"
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed|not revertable" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "RSG revert did not converge (see /tmp/cdkrd-$STACK.revert.out)"
sleep 15
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after RSG revert"
V="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Name=='mixed-case.cdkrd-fphunt-a0810.com.' && Type=='A'].TTL" --output text)"
[ "$V" = "300" ] || fail "RSG member TTL not restored: $V"

echo "INTEG OK ($STACK)"

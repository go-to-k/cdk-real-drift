#!/usr/bin/env bash
# Detection (FN) + revert-convergence probe for the kmsdlm-hunt pair (#1663 piggyback):
# deploy -> first check CLEAN (proves the #1663 folds live) -> rev=2 redeploy echo probe
# -> record -> out-of-band mutations (DLM shorthand RetainInterval 7->5; KMS NakedKey
# disable) -> check --fail MUST detect -> revert -> LIVE values must converge (judge by
# the live read, not the revert rc) -> final check CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACKS=(CdkrdHunt0717KmsA CdkrdHunt0717DlmB)
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup (${STACKS[*]}) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (kmsdlm-hunt detect): $*"; exit 1; }

echo "=== deploy (both stacks) ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] FIRST check MUST be CLEAN (proves #1663 folds) ==="
  $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.pre.out"
  RC=${PIPESTATUS[0]}
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] first check not clean (rc=$RC)"
done

echo "=== rev=2 redeploy (post-update echo probe) ==="
npx cdk deploy -f --all --require-approval never -c rev=2 || fail "rev=2 deploy"
for STACK in "${STACKS[@]}"; do
  $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.rev2.out"
  RC=${PIPESTATUS[0]}
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.rev2.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] post-update echo check not clean (rc=$RC)"
done

echo "=== record both stacks ==="
for STACK in "${STACKS[@]}"; do
  $CLI record "$STACK" --region "$REGION" --yes || fail "[$STACK] record"
done

DLM_ID=$(aws cloudformation describe-stack-resource --stack-name CdkrdHunt0717DlmB \
  --logical-resource-id DefaultPolicy --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
KEY_ID=$(aws cloudformation describe-stack-resource --stack-name CdkrdHunt0717KmsA \
  --logical-resource-id NakedKey --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
echo "DLM_ID=$DLM_ID KEY_ID=$KEY_ID"

echo "=== OOB mutate: DLM RetainInterval 7->5, KMS NakedKey disable ==="
aws dlm update-lifecycle-policy --policy-id "$DLM_ID" --retain-interval 5 --region "$REGION" || fail "dlm mutate"
aws kms disable-key --key-id "$KEY_ID" --region "$REGION" || fail "kms disable"
sleep 10

echo "=== check MUST detect both ==="
$CLI check CdkrdHunt0717DlmB --region "$REGION" --fail > /tmp/cdkrd-dlm.detect.out 2>&1
[ $? -eq 1 ] || { cat /tmp/cdkrd-dlm.detect.out; fail "DLM drift not detected (RetainInterval)"; }
grep -q "RetainInterval" /tmp/cdkrd-dlm.detect.out || { cat /tmp/cdkrd-dlm.detect.out; fail "RetainInterval not in DLM findings"; }
$CLI check CdkrdHunt0717KmsA --region "$REGION" --fail > /tmp/cdkrd-kms.detect.out 2>&1
[ $? -eq 1 ] || { cat /tmp/cdkrd-kms.detect.out; fail "KMS drift not detected (Enabled=false)"; }
grep -q "Enabled" /tmp/cdkrd-kms.detect.out || { cat /tmp/cdkrd-kms.detect.out; fail "Enabled not in KMS findings"; }
echo "detection OK (both)"

echo "=== revert both ==="
$CLI revert CdkrdHunt0717DlmB --region "$REGION" --yes | tee /tmp/cdkrd-dlm.revert.out || fail "dlm revert rc"
$CLI revert CdkrdHunt0717KmsA --region "$REGION" --yes | tee /tmp/cdkrd-kms.revert.out || fail "kms revert rc"

echo "=== judge by LIVE values ==="
sleep 10
RI_TOP=$(aws dlm get-lifecycle-policy --policy-id "$DLM_ID" --region "$REGION" --output json \
  | python3 -c "import json,sys; p=json.load(sys.stdin)['Policy']; print(p.get('PolicyDetails',{}).get('RetainInterval', p.get('RetainInterval')))")
echo "live RetainInterval after revert: $RI_TOP"
[ "$RI_TOP" = "7" ] || fail "DLM RetainInterval did not converge to 7 (live=$RI_TOP) — RSDP candidate"
KEY_STATE=$(aws kms describe-key --key-id "$KEY_ID" --region "$REGION" --query 'KeyMetadata.Enabled' --output text)
echo "live KMS Enabled after revert: $KEY_STATE"
[ "$KEY_STATE" = "True" ] || fail "KMS key did not re-enable (live=$KEY_STATE)"

echo "=== final check MUST be CLEAN ==="
for STACK in "${STACKS[@]}"; do
  $CLI check "$STACK" --region "$REGION" --fail || fail "[$STACK] final check not clean"
done

echo "INTEG OK (kmsdlm-hunt detect)"

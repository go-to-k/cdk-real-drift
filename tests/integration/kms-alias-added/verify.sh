#!/usr/bin/env bash
# cdk-real-drift `added` integ test for KMS (the TWELFTH CHILD_ENUMERATORS member).
#   deploy fixture (KMS Key + one declared Alias) -> record -> CLEAN
#   -> create-alias an undeclared alias pointing at the SAME key out of band -> check
#      reports the alias under [Potential Drift] and is NOT drift (exit 0) -> `record`
#      snapshots it (proves CC GetResource + normalize for AWS::KMS::Alias) -> CLEAN
#   -> add ANOTHER out-of-band alias -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap removes the
# out-of-band aliases (account-global per region, so they would collide on re-run) and
# tears the stack down even on failure. The KMS key goes to PendingDeletion (KMS cannot
# hard-delete) — EXPECTED, not an orphan.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/kms-alias-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegKmsAliasAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Out-of-band aliases are account-global per region: a recorded-but-not-reverted alias
  # would COLLIDE with `create-alias` on the next run and is not a stack member, so
  # delstack cannot reach it. Remove them FIRST, then tear the stack down.
  for a in alias/cdkrd-integ-oob-record alias/cdkrd-integ-oob-revert; do
    aws kms delete-alias --alias-name "$a" --region "$REGION" >/dev/null 2>&1 || true
  done
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_alias() { # $1 = alias name -> points it at the fixture key
  aws kms create-alias --alias-name "$1" --target-key-id "$KEYID" --region "$REGION" \
    >/dev/null || fail "create-alias $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (the declared alias must NOT flag) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

KEYID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::KMS::Key'].PhysicalResourceId" --output text)"
[ -n "$KEYID" ] || fail "could not resolve KMS Key id"

echo "=== create an undeclared alias on the key out of band ==="
inject_alias alias/cdkrd-integ-oob-record

echo "=== check reports the alias as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-kms.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-kms.out || fail "added alias not under [Potential Drift]"
grep -q "AWS::KMS::Alias" /tmp/cdkrd-integ-kms.out || fail "the out-of-band alias not reported"
grep -q "added=" /tmp/cdkrd-integ-kms.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added alias (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the AliasName) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-kms-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added alias, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-kms-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band alias for the revert path ==="
inject_alias alias/cdkrd-integ-oob-revert

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-kms-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-kms-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-kms-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-kms-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second alias must be gone from AWS ==="
remaining="$(aws kms list-aliases --key-id "$KEYID" --region "$REGION" \
  --query "Aliases[?AliasName=='alias/cdkrd-integ-oob-revert']" --output text 2>/dev/null)"
[ -z "$remaining" ] || fail "the reverted alias still exists (delete did not take effect)"

echo "INTEG PASS"

#!/usr/bin/env bash
# NetworkAclEntry detect integration test (real AWS): the false-negative this fix closes.
# Before the SDK_OVERRIDES reader, a NACL entry changed out of band was SILENTLY skipped —
# the drift was invisible. Deploy -> record -> change a declared entry out of band
# (RuleAction allow->deny on rule 130, the security-relevant field) -> check MUST DETECT the
# declared drift (exit 1). NetworkAclEntry has no Cloud Control write handler and no SDK
# writer, so revert is not available — this is a detect-only test (the entry is restored
# manually before teardown).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegNaclEntry
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

NACL="$(aws ec2 describe-network-acls --region "$REGION" \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
  --query "NetworkAcls[?Entries[?RuleNumber==\`130\`]]|[0].NetworkAclId" --output text)"
[ -n "$NACL" ] && [ "$NACL" != "None" ] || fail "could not resolve network ACL id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: flip rule 130 RuleAction deny -> allow ==="
aws ec2 replace-network-acl-entry --network-acl-id "$NACL" --region "$REGION" \
  --rule-number 130 --protocol 6 --rule-action allow --ingress \
  --cidr-block 10.0.0.0/8 --port-range From=25,To=25 >/dev/null || fail "mutate entry"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-naclentry-detect.out
rc=${PIPESTATUS[0]}
restore() {
  aws ec2 replace-network-acl-entry --network-acl-id "$NACL" --region "$REGION" \
    --rule-number 130 --protocol 6 --rule-action deny --ingress \
    --cidr-block 10.0.0.0/8 --port-range From=25,To=25 >/dev/null 2>&1 || true
}
[ "$rc" -eq 1 ] || { restore; fail "expected drift exit 1, got $rc"; }
grep -q "RuleAction" /tmp/cdkrd-naclentry-detect.out || { restore; fail "RuleAction drift not reported"; }

echo "=== restore the live entry (no CC/SDK revert for NetworkAclEntry) ==="
restore
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after manual restore"

echo "INTEG PASS ($STACK detect-only)"

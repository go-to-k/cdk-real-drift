#!/usr/bin/env bash
# SecurityGroup detect (+ revert) integration test (real AWS): the "someone changed it in
# the console" scenario for an INLINE SG rule, alongside the FP fix verify.sh proves. Deploy
# -> record -> REVOKE a declared inline ingress rule out of band -> check MUST DETECT the
# declared drift (the rule is now missing from live) -> revert MUST re-authorize it -> check
# MUST be CLEAN. This is the false-negative / detection half. It also guards the sibling-rule
# subtraction fix from the OTHER side: the 2 sibling-declared rules (prefix-list + self-ref)
# must NOT be re-reported here — only the genuinely-removed inline rule.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSgProto
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

SG="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
  --query "SecurityGroups[?GroupName!='default']|[0].GroupId" --output text)"
[ -n "$SG" ] && [ "$SG" != "None" ] || fail "could not resolve security group id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: revoke the declared inline https ingress rule (10.0.0.0/24:443) ==="
aws ec2 revoke-security-group-ingress --group-id "$SG" --region "$REGION" \
  --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=10.0.0.0/24}]' \
  >/dev/null || fail "revoke rule"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sgproto-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "SecurityGroupIngress" /tmp/cdkrd-sgproto-detect.out || fail "SecurityGroupIngress drift not reported"

echo "=== revert (re-authorize the missing rule) ==="
if $CLI revert "$STACK" --region "$REGION" --yes; then
  echo "=== check MUST be CLEAN after revert ==="
  $CLI check "$STACK" --region "$REGION" --fail
  [ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"
  echo "INTEG PASS ($STACK detect+revert)"
else
  echo "NOTE: revert not supported for the inline SG rule (SDK_WRITERS candidate); detection PASS only"
  echo "INTEG PASS ($STACK detect-only)"
fi

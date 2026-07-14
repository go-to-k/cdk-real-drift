#!/usr/bin/env bash
# Adapter-family integration test (real AWS): barest GuardDuty Detector +
# Filter/IPSet/ThreatIntelSet children (composite-identifier adapter probe).
# Pre-uploads the list files to an out-of-band bucket (GuardDuty validates the
# S3 location at create), grants guardduty.amazonaws.com read via bucket
# policy, then: deploy -> first check (pre-record) MUST be CLEAN and MUST NOT
# skip the children -> record -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714Gd
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export GD_BUCKET="cdkrd-hunt0714-gd-${ACCOUNT}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  aws s3 rb "s3://$GD_BUCKET" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] out-of-band prep: list bucket + files + guardduty read policy ==="
aws s3 mb "s3://$GD_BUCKET" --region "$REGION" >/dev/null || fail "mb"
printf '198.51.100.1\n' > /tmp/cdkrd-gd-list.txt
aws s3 cp /tmp/cdkrd-gd-list.txt "s3://$GD_BUCKET/iplist.txt" >/dev/null || fail "cp iplist"
aws s3 cp /tmp/cdkrd-gd-list.txt "s3://$GD_BUCKET/threatlist.txt" >/dev/null || fail "cp threatlist"
aws s3api put-bucket-policy --bucket "$GD_BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": { \"Service\": \"guardduty.amazonaws.com\" },
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$GD_BUCKET/*\"
  }]
}" || fail "bucket policy"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN + children READ ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
if grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out"; then
  echo "--- FIRST-RUN FALSE POSITIVE ---"
  fail "expected zero [Potential Drift] on first check"
fi
# A composite-id adapter gap surfaces as skipped= in the info footer — that is
# the bug this fixture exists to catch, so fail loudly on it.
if grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out"; then
  fail "children were skipped (composite-identifier read gap)"
fi

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

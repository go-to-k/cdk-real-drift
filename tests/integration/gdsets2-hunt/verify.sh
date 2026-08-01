#!/usr/bin/env bash
# GuardDuty entity-set / publishing-destination adapter probe + Filter Action
# revert-convergence probe: prep list bucket, deploy, first check MUST be CLEAN
# with zero skipped, record, OOB update-filter --action ARCHIVE -> detect ->
# revert -> live action MUST be back to NOOP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722Gd2
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export GD_BUCKET="cdkrd-hunt0722-gd-${ACCOUNT}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  aws s3 rb "s3://$GD_BUCKET" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] out-of-band prep: list bucket + files + guardduty read policy ==="
aws s3 mb "s3://$GD_BUCKET" --region "$REGION" >/dev/null || fail "mb"
printf '198.51.100.1\n' > /tmp/cdkrd-gd2-list.txt
aws s3 cp /tmp/cdkrd-gd2-list.txt "s3://$GD_BUCKET/threatlist.txt" >/dev/null || fail "cp threatlist"
aws s3 cp /tmp/cdkrd-gd2-list.txt "s3://$GD_BUCKET/trustedlist.txt" >/dev/null || fail "cp trustedlist"
aws s3api put-bucket-policy --bucket "$GD_BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": { \"Service\": \"guardduty.amazonaws.com\" },
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$GD_BUCKET/*\"
  }]
}" || fail "bucket policy"

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN + zero skipped ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-gdsets2}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"
grep -q "skipped=" "/tmp/cdkrd-$STACK.pre.out" && fail "resources skipped (composite-identifier read gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "=== [$STACK] Filter Action probe: OOB NOOP -> ARCHIVE ==="
DETECTOR_ID="$(aws guardduty list-detectors --region "$REGION" --query 'DetectorIds[0]' --output text)"
[ -n "$DETECTOR_ID" ] && [ "$DETECTOR_ID" != "None" ] || fail "no detector id"
aws guardduty update-filter --detector-id "$DETECTOR_ID" --filter-name cdkrd-hunt0722-filter --action ARCHIVE --region "$REGION" >/dev/null || fail "OOB update-filter"
sleep 10

$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.mut.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "MISSED DETECTION: expected exit 1 after OOB filter Action change (got $rc)"

echo "=== [$STACK] revert + live convergence (Action MUST return to NOOP) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.rev.out" || fail "revert errored"
sleep 10
LIVE_ACTION="$(aws guardduty get-filter --detector-id "$DETECTOR_ID" --filter-name cdkrd-hunt0722-filter --region "$REGION" --query 'Action' --output text)"
[ "$LIVE_ACTION" = "NOOP" ] || fail "REVERT NO-OP: live filter Action=$LIVE_ACTION (expected NOOP) — RSDP candidate"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "=== [$STACK] #1694 ExpectedBucketOwner probe: OOB own-account -> foreign ==="
# Target the INACTIVE set: GuardDuty validates the expected owner against the real
# bucket owner for ACTIVE sets (foreign value rejected with AccessDeniedException,
# live-determined 2026-08-01), so only the inactive set can carry the divergence.
TES_ID=""
for id in $(aws guardduty list-threat-entity-sets --detector-id "$DETECTOR_ID" --region "$REGION" --query 'ThreatEntitySetIds[]' --output text); do
  NAME="$(aws guardduty get-threat-entity-set --detector-id "$DETECTOR_ID" --threat-entity-set-id "$id" --region "$REGION" --query 'Name' --output text)"
  [ "$NAME" = "cdkrd-hunt0722-threat-entity-set-inactive" ] && TES_ID="$id" && break
done
[ -n "$TES_ID" ] || fail "no inactive threat entity set id"
aws guardduty update-threat-entity-set --detector-id "$DETECTOR_ID" --threat-entity-set-id "$TES_ID" \
  --expected-bucket-owner 111122223333 --region "$REGION" || fail "OOB update-threat-entity-set"
sleep 10

$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.ebo.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "MISSED DETECTION: expected exit 1 after OOB ExpectedBucketOwner change (got $rc)"

echo "=== [$STACK] #1694 revert: EBO MUST converge back to the caller account (explicit set-default) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.eborev.out" || fail "EBO revert errored"
grep -q "NOT reverted" "/tmp/cdkrd-$STACK.eborev.out" && fail "EBO revert reported NOT reverted"
sleep 10
LIVE_EBO="$(aws guardduty get-threat-entity-set --detector-id "$DETECTOR_ID" --threat-entity-set-id "$TES_ID" --region "$REGION" --query 'ExpectedBucketOwner' --output text)"
[ "$LIVE_EBO" = "$ACCOUNT" ] || fail "EBO REVERT NO-OP: live ExpectedBucketOwner=$LIVE_EBO (expected $ACCOUNT) — the #1694 bare-remove class"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-EBO-revert check not clean"

echo "INTEG PASS ($STACK)"

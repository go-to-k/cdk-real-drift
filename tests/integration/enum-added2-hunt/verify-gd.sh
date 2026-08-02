#!/usr/bin/env bash
# enum-added2-hunt / GuardDuty half (2026-08-03): live proof of the
# AWS::GuardDuty::Detector child enumerator (#1720). Separate stack because a
# detector is an account singleton — its create fails independently when the
# account already has one. Declared Filter must NOT flag; an OOB create-filter
# must surface as `added`; revert deletes it; CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0803GdEnum
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  if [ -n "${DETECTOR_ID:-}" ]; then
    aws guardduty delete-filter --detector-id "$DETECTOR_ID" --filter-name cdkrd-oob-filter --region "$REGION" >/dev/null 2>&1 || true
  fi
  delstack -s "$STACK" -r "$REGION" -y -f >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out.gd
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+ \(AWS::' || true
}

echo "=== [$STACK] deploy fixture (separate cdk.out.gd — verify.sh owns cdk.out) ==="
npx cdk deploy -f "$STACK" --output cdk.out.gd --require-approval never || fail "deploy (account may already have a GuardDuty detector)"

DETECTOR_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::GuardDuty::Detector'].PhysicalResourceId|[0]" --output text)

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-enum-added2}" $CLI check "$STACK" --app cdk.out.gd --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --app cdk.out.gd --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --app cdk.out.gd --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] OOB create-filter MUST surface as added ==="
aws guardduty create-filter --detector-id "$DETECTOR_ID" --name cdkrd-oob-filter \
  --finding-criteria '{"Criterion":{"severity":{"Gte":7}}}' --region "$REGION" >/dev/null || fail "oob create-filter"
$CLI check "$STACK" --app cdk.out.gd --region "$REGION" | tee "/tmp/cdkrd-$STACK.oob.out"
grep -q "cdkrd-oob-filter" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB GuardDuty filter not surfaced as added"

echo "=== [$STACK] revert (--remove-unrecorded) MUST delete the OOB filter ==="
$CLI revert "$STACK" --app cdk.out.gd --region "$REGION" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qiE "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence deleting the OOB filter"
aws guardduty get-filter --detector-id "$DETECTOR_ID" --filter-name cdkrd-oob-filter --region "$REGION" >/dev/null 2>&1 && fail "OOB filter still exists after revert"
$CLI check "$STACK" --app cdk.out.gd --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# False-positive integration test (real AWS) for a CFn-managed AWS Config recorder +
# delivery channel (#1553). Deploy the fixture, record baseline, check MUST be CLEAN.
# Any [Potential Drift] on a freshly deployed + recorded recorder/channel is a fold gap.
#
# The recorder + delivery channel are account/region SINGLETONS: this aborts unless the
# target region has NEITHER, so it never fights a real recorder. The recorder's CFn
# handler is known to hang CREATE_IN_PROGRESS 20-45+ min in some account/region combos
# (see #1553) — deploy defaults to us-west-2 (us-east-1 hung during filing) and caps the
# wait at DEPLOY_TIMEOUT so a hang fails loudly instead of blocking forever.
set -uo pipefail
export AWS_CLI_AUTO_PROMPT=off
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegConfigRecorder
REGION="${AWS_REGION:-us-west-2}"
CLI="node $ROOT/dist/cli.js"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-1500}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  # A stack stuck CREATE_IN_PROGRESS cannot be delstack'd; cancel it first (the
  # documented exception), then force-delete + sweep.
  aws cloudformation cancel-update-stack --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 \
    || aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] singleton pre-check (region $REGION) ==="
rec="$(aws configservice describe-configuration-recorders --region "$REGION" --query 'ConfigurationRecorders[].name' --output text 2>/dev/null)"
chan="$(aws configservice describe-delivery-channels --region "$REGION" --query 'DeliveryChannels[].name' --output text 2>/dev/null)"
if [ -n "$rec" ] || [ -n "$chan" ]; then
  fail "region $REGION already has a Config recorder [$rec] / delivery channel [$chan] — aborting (these are account/region singletons; never fight a real one). Pick an empty region via AWS_REGION."
fi

echo "=== [$STACK] deploy fixture (cap ${DEPLOY_TIMEOUT}s — recorder CC handler may hang, #1553) ==="
timeout "$DEPLOY_TIMEOUT" npx cdk deploy -f "$STACK" --require-approval never
rc=$?
[ "$rc" -eq 124 ] && fail "deploy exceeded ${DEPLOY_TIMEOUT}s — the recorder CC handler likely hung CREATE_IN_PROGRESS (#1553). Retry a different region."
[ "$rc" -eq 0 ] || fail "deploy (rc=$rc)"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

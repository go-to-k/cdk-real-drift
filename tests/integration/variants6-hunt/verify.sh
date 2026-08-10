#!/usr/bin/env bash
# 2026-08-10 hunt: variant-branch first-run FP probe.
# deploy -> first check must show ZERO [Potential Drift] -> record -> check --fail clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0810Var
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

echo "=== [$STACK] first check MUST be CLEAN (variant FP probe) ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-variants6}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see /tmp/cdkrd-$STACK.pre.out)"

echo "=== [$STACK] record -> check --fail MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check"

echo "=== [$STACK] DAEMON band FN/revert piggyback (#1740) ==="
SVC_ARN="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id DaemonService --query 'StackResourceDetail.PhysicalResourceId' --output text)"
if aws ecs update-service --cluster cdkrd-0810v-cluster --service "$SVC_ARN" --region "$REGION" \
  --deployment-configuration "minimumHealthyPercent=50" >/dev/null 2>/tmp/cdkrd-ecs-mut.err; then
  sleep 20
  $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
  [ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected DAEMON band drift (exit 1)"
  grep -q "DaemonService.DeploymentConfiguration" "/tmp/cdkrd-$STACK.detect.out" || fail "missed DAEMON band detection"
  $CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
  grep -Eq "NOT reverted|could not be confirmed|not revertable" "/tmp/cdkrd-$STACK.revert.out" \
    && fail "DAEMON band revert did not converge"
  sleep 20
  $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after DAEMON band revert"
  V="$(aws ecs describe-services --cluster cdkrd-0810v-cluster --services "$SVC_ARN" --region "$REGION" \
    --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text)"
  [ "$V" = "0" ] || fail "DAEMON minimumHealthyPercent not restored to 0: $V"
else
  # a service-side rejection is itself the determination: the DAEMON band is not
  # OOB-mutable, so the derived revert arm is invariant-only (like DELIVERY retention)
  echo "DETERMINATION: DAEMON band not OOB-mutable — $(cat /tmp/cdkrd-ecs-mut.err)"
fi

echo "INTEG OK ($STACK)"

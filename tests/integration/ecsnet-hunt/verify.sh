#!/usr/bin/env bash
# ECS AssignPublicIp revert-convergence probe: deploy (desiredCount 0), first
# check CLEAN, record, OOB flip AssignPublicIp ENABLED -> detect -> revert ->
# LIVE value MUST be back to DISABLED.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0722EcsNet
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CLUSTER=cdkrd-hunt0722-ecsnet
SVC=cdkrd-hunt0722-ecsnet-svc

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-ecsnet}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FALSE POSITIVE (expected zero Potential Drift)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record FALSE POSITIVE"

echo "=== [$STACK] OOB flip AssignPublicIp -> ENABLED ==="
SUBNET="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets[0]' --output text)"
SG="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text)"
aws ecs update-service --cluster "$CLUSTER" --service "$SVC" --region "$REGION" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" >/dev/null || fail "OOB update-service"
sleep 20

$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.mut.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "MISSED DETECTION: expected exit 1 after OOB AssignPublicIp flip (got $rc)"

echo "=== [$STACK] revert + live convergence (AssignPublicIp MUST be DISABLED) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.rev.out" || fail "revert errored"
sleep 20
LIVE_API="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.assignPublicIp' --output text)"
[ "$LIVE_API" = "DISABLED" ] || fail "REVERT NO-OP: live assignPublicIp=$LIVE_API (expected DISABLED) — RSDP/writer candidate"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG PASS ($STACK)"

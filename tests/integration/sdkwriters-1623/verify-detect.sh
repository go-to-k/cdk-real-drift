#!/usr/bin/env bash
# #1623 live verify: mutate the CodeBuild timeouts + MediaConvert queue status
# out of band -> check MUST DETECT -> revert (via the new SDK writers) -> check
# MUST be CLEAN -> the LIVE values MUST be back at their defaults. The first
# check doubles as the instance-target TCP TargetGroup attribute-bag FP probe.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=Cdkrd1623Writers
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CB=cdkrd-1623-cb
MCQ=cdkrd-1623-mcq

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN (instance-TCP TG probe), then record ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-1623}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see pre.out)"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate out of band ==="
aws codebuild update-project --name "$CB" --region "$REGION" \
  --timeout-in-minutes 30 --queued-timeout-in-minutes 240 >/dev/null || fail "mutate codebuild"
aws mediaconvert update-queue --name "$MCQ" --region "$REGION" --status PAUSED >/dev/null \
  || fail "mutate mediaconvert"
sleep 20

echo "=== [$STACK] check MUST DETECT all 3 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for needle in TimeoutInMinutes QueuedTimeoutInMinutes Status; do
  grep -q "$needle" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: $needle"
done

echo "=== [$STACK] revert (via the new SDK writers) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed|not revertable" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged / not-revertable path (see output)"
sleep 20

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert — a revert did not converge"

echo "=== [$STACK] live values MUST be back at their defaults ==="
CBT="$(aws codebuild batch-get-projects --names "$CB" --region "$REGION" \
  --query 'projects[0].[timeoutInMinutes,queuedTimeoutInMinutes]' --output text)"
[ "$CBT" = "60	480" ] || fail "CodeBuild timeouts still $CBT (revert no-op)"
MCS="$(aws mediaconvert get-queue --name "$MCQ" --region "$REGION" --query 'Queue.Status' --output text)"
[ "$MCS" = "ACTIVE" ] || fail "MediaConvert Queue Status still $MCS (revert no-op)"

echo "INTEG PASS ($STACK #1623 SDK writers)"

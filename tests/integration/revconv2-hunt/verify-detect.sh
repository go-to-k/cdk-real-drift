#!/usr/bin/env bash
# Revert-convergence probe batch 3 (real AWS): mutate six folded MUTABLE surfaces
# out of band -> check MUST DETECT -> revert -> check MUST be CLEAN -> the LIVE
# values MUST be back at their defaults (a silent no-op revert is the #1571 bug
# class; the API shape is not a predictor, only this live test answers).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714RevConv2
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
BUS_NAME=cdkrd-hunt0714-conv2-bus

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?LogicalResourceId=='$1'].PhysicalResourceId" --output text
}

wait_stream_active() {
  for _ in $(seq 1 60); do
    st="$(aws kinesis describe-stream-summary --stream-name "$1" --region "$REGION" \
      --query 'StreamDescriptionSummary.StreamStatus' --output text 2>/dev/null)"
    [ "$st" = "ACTIVE" ] && return 0
    sleep 5
  done
  return 1
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN, then record ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP before the probe even starts"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

TBL="$(phys Conv2Table)"
BKT="$(phys Conv2Bucket)"
LG="$(phys Conv2LogGroup)"
REPO="$(phys Conv2Repo)"
STREAM="$(phys Conv2Stream)"
STREAM_ARN="$(aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" \
  --query 'StreamDescriptionSummary.StreamARN' --output text)"

echo "=== [$STACK] mutate out of band (6 surfaces) ==="
aws dynamodb update-continuous-backups --table-name "$TBL" --region "$REGION" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null || fail "mutate PITR"
aws s3api put-bucket-versioning --bucket "$BKT" --region "$REGION" \
  --versioning-configuration Status=Enabled || fail "mutate versioning"
aws logs put-retention-policy --log-group-name "$LG" --region "$REGION" \
  --retention-in-days 7 || fail "mutate retention"
aws ecr put-image-scanning-configuration --repository-name "$REPO" --region "$REGION" \
  --image-scanning-configuration scanOnPush=true >/dev/null || fail "mutate scanOnPush"
aws events update-event-bus --name "$BUS_NAME" --region "$REGION" \
  --log-config '{"IncludeDetail":"FULL","Level":"INFO"}' >/dev/null || fail "mutate bus log-config"
aws kinesis update-stream-mode --stream-arn "$STREAM_ARN" --region "$REGION" \
  --stream-mode-details StreamMode=ON_DEMAND || fail "mutate stream mode"
wait_stream_active "$STREAM" || fail "stream not ACTIVE after mode switch"

echo "=== [$STACK] check MUST DETECT all 6 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for needle in PointInTimeRecovery Versioning RetentionInDays ImageScanningConfiguration LogConfig StreamModeDetails; do
  grep -q "$needle" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: $needle"
done

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged path (see output)"
wait_stream_active "$STREAM" || fail "stream not ACTIVE after revert"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert — a revert did not converge"

echo "=== [$STACK] live values MUST be back at their defaults ==="
PITR="$(aws dynamodb describe-continuous-backups --table-name "$TBL" --region "$REGION" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)"
[ "$PITR" = "DISABLED" ] || fail "PITR still $PITR (revert no-op)"
VER="$(aws s3api get-bucket-versioning --bucket "$BKT" --region "$REGION" --query 'Status' --output text)"
[ "$VER" = "Suspended" ] || fail "bucket versioning still $VER (revert no-op)"
RET="$(aws logs describe-log-groups --log-group-name-prefix "$LG" --region "$REGION" \
  --query 'logGroups[0].retentionInDays' --output text)"
[ "$RET" = "None" ] || fail "log retention still $RET (revert no-op)"
SCAN="$(aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" \
  --query 'repositories[0].imageScanningConfiguration.scanOnPush' --output text)"
[ "$SCAN" = "False" ] || fail "scanOnPush still $SCAN (revert no-op)"
LVL="$(aws events describe-event-bus --name "$BUS_NAME" --region "$REGION" \
  --query 'LogConfig.Level' --output text 2>/dev/null)"
{ [ "$LVL" = "OFF" ] || [ "$LVL" = "None" ] || [ -z "$LVL" ]; } || fail "bus log level still $LVL (revert no-op)"
MODE="$(aws kinesis describe-stream-summary --stream-name "$STREAM" --region "$REGION" \
  --query 'StreamDescriptionSummary.StreamModeDetails.StreamMode' --output text)"
[ "$MODE" = "PROVISIONED" ] || fail "stream mode still $MODE (revert no-op)"

echo "INTEG PASS ($STACK detect+revert batch 3)"

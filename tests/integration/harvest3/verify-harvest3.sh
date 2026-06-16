#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test wave 3 (real AWS) — R74.
#
# Two jobs in one deploy:
#   A. HARVEST new service families (Cognito, KMS, Secrets Manager, Scheduler,
#      Firehose, SES, Cloud Map, AppSync, CloudTrail, AWS Backup):
#      1. baseline-free `check` — a FRESH deploy must classify with ZERO
#         declared drift across every type, exit 0;
#      2. `record --yes` then `check --fail` — CLEAN across every type.
#   B. MULTI-TYPE REVERT MATRIX (first live proof beyond S3): mutate the
#      declared value of five Cloud-Control-routed resources out-of-band
#      (Lambda MemorySize, SQS VisibilityTimeout, Logs RetentionInDays,
#      SNS DisplayName, Events Rule State), confirm ONE `check` reports all
#      five as DECLARED drift, then ONE `revert --yes` restores all five via
#      CC UpdateResource — verified both by `check --fail` CLEAN and by
#      direct per-service AWS reads.
#
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases. The script
# snapshots the drift-state recordings to ${CDKRD_CORPUS_DIR}.drifted before
# the post-revert check overwrites them — so one run yields BOTH a clean and
# a drifted corpus case per matrix type.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest3 && npm install && bash verify-harvest3.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdIntegHarvest3
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest3.out

cleanup() {
  # CDKRD_HARVEST3_KEEP=1 skips the destroy so a corpus/debug session can keep
  # iterating against the deployed stack. Destroy manually when done:
  #   delstack cdk -a cdk.out -r us-east-1 -f -y && rm -rf .cdkrd cdk.out
  if [ -n "${CDKRD_HARVEST3_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_HARVEST3_KEEP set) — destroy manually when done ---"
    return
  fi
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

phys() { # phys <ResourceType> <LogicalIdPrefix>
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1' && starts_with(LogicalResourceId,'$2')].PhysicalResourceId" \
    --output text
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (wave 3: new families + revert-matrix targets) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== A1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== A2. record + check --fail must be CLEAN across every type ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "=== B1. resolve matrix physical ids ==="
FN_NAME="$(phys AWS::Lambda::Function MatrixFn)"
QUEUE_URL="$(phys AWS::SQS::Queue MatrixQueue)"
LOG_GROUP="$(phys AWS::Logs::LogGroup MatrixLogs)"
TOPIC_ARN="$(phys AWS::SNS::Topic MatrixTopic)"
RULE_NAME="$(phys AWS::Events::Rule MatrixRule)"
for v in FN_NAME QUEUE_URL LOG_GROUP TOPIC_ARN RULE_NAME; do
  [ -n "${!v}" ] || fail "could not resolve $v"
done

echo "=== B2. inject 5 declared drifts out-of-band (one per type) ==="
aws lambda update-function-configuration --function-name "$FN_NAME" --memory-size 512 --region "$REGION" >/dev/null || fail "inject lambda"
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes VisibilityTimeout=120 --region "$REGION" || fail "inject sqs"
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30 --region "$REGION" || fail "inject logs"
aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name DisplayName --attribute-value "mutated out of band" --region "$REGION" || fail "inject sns"
aws events disable-rule --name "$RULE_NAME" --region "$REGION" || fail "inject events"
sleep 10

echo "=== B3. one check must report ALL FIVE as DECLARED drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "DECLARED DRIFT: 5" "$OUT" || fail "expected exactly 5 declared drifts"
for needle in MemorySize VisibilityTimeout RetentionInDays DisplayName MatrixRule; do
  grep -q "$needle" "$OUT" || fail "missing declared drift: $needle"
done

if [ -n "${CDKRD_CORPUS_DIR:-}" ]; then
  echo "=== snapshot drift-state corpus recordings ==="
  rm -rf "${CDKRD_CORPUS_DIR}.drifted"
  cp -R "$CDKRD_CORPUS_DIR" "${CDKRD_CORPUS_DIR}.drifted" || fail "corpus snapshot"
fi

echo "=== B4. ONE revert --yes restores all five via Cloud Control ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert returned non-zero"
sleep 10

echo "=== B5. check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "drift remains after revert"

echo "=== B6. direct AWS reads confirm every value restored ==="
MEM="$(aws lambda get-function-configuration --function-name "$FN_NAME" --region "$REGION" --query MemorySize --output text)"
[ "$MEM" = "256" ] || fail "lambda MemorySize not restored (got $MEM)"
VIS="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names VisibilityTimeout --region "$REGION" --query "Attributes.VisibilityTimeout" --output text)"
[ "$VIS" = "60" ] || fail "sqs VisibilityTimeout not restored (got $VIS)"
RET="$(aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "$REGION" --query "logGroups[?logGroupName=='$LOG_GROUP'].retentionInDays | [0]" --output text)"
[ "$RET" = "7" ] || fail "logs retention not restored (got $RET)"
DISP="$(aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --query "Attributes.DisplayName" --output text)"
[ "$DISP" = "cdkrd harvest3 matrix" ] || fail "sns DisplayName not restored (got $DISP)"
STATE="$(aws events describe-rule --name "$RULE_NAME" --region "$REGION" --query State --output text)"
[ "$STATE" = "ENABLED" ] || fail "events rule State not restored (got $STATE)"

echo "INTEG PASS"

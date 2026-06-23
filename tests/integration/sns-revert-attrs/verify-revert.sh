#!/usr/bin/env bash
# SNS Topic revert-gap probe (real AWS): deploy -> harvest corpus (fresh, pre-record)
# -> record -> mutate FOUR mutable topic attributes out of band -> check MUST DETECT
# (exit 1) -> revert (Cloud Control UpdateResource) -> check MUST be CLEAN -> assert
# each live attribute restored. A post-revert drift names any attribute Cloud Control
# could not write back (a "CC-readable but CC-revert-rejects" gap needing an SDK writer).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSnsRevertAttrs
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CORPUS_DIR="${CORPUS_DIR:-/tmp/corpus-sns-revert}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)"
[ -n "$ARN" ] || fail "could not resolve topic ARN"
echo "topic: $ARN"

echo "=== harvest corpus (fresh, pre-record) -> $CORPUS_DIR ==="
rm -rf "$CORPUS_DIR"
CDKRD_CORPUS_DIR="$CORPUS_DIR" $CLI check "$STACK" --region "$REGION" || true

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

ORIG_KMS="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" \
  --query "Attributes.KmsMasterKeyId" --output text)"
echo "original KmsMasterKeyId: $ORIG_KMS"

echo "=== out-of-band: mutate DisplayName / SignatureVersion / TracingConfig / KmsMasterKeyId ==="
aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" --attribute-name DisplayName     --attribute-value "drifted out of band" >/dev/null || fail "mutate DisplayName"
aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" --attribute-name SignatureVersion --attribute-value "1"                   >/dev/null || fail "mutate SignatureVersion"
aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" --attribute-name TracingConfig    --attribute-value "PassThrough"         >/dev/null || fail "mutate TracingConfig"
aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" --attribute-name KmsMasterKeyId   --attribute-value "alias/aws/sns"       >/dev/null || fail "mutate KmsMasterKeyId"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sns-revert-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
for p in DisplayName SignatureVersion TracingConfig KmsMasterKeyId; do
  grep -q "$p" /tmp/cdkrd-sns-revert-detect.out || echo "  NOTE: $p not in detect output (read gap?)"
done

echo "=== revert (Cloud Control UpdateResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert command errored"

echo "=== check after revert (names any CC-revert gap) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sns-revert-after.out
rc=${PIPESTATUS[0]}

echo "=== live attribute values after revert ==="
GOT_DN="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" --query "Attributes.DisplayName" --output text)"
GOT_SV="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" --query "Attributes.SignatureVersion" --output text)"
GOT_TC="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" --query "Attributes.TracingConfig" --output text)"
GOT_KMS="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" --query "Attributes.KmsMasterKeyId" --output text)"
echo "  DisplayName     = $GOT_DN   (want: cdkrd revert original)"
echo "  SignatureVersion= $GOT_SV   (want: 2)"
echo "  TracingConfig   = $GOT_TC   (want: Active)"
echo "  KmsMasterKeyId  = $GOT_KMS  (want: NOT alias/aws/sns)"

[ "$rc" -eq 0 ] || fail "post-revert check still reports drift — see /tmp/cdkrd-sns-revert-after.out for the CC-revert gap"
[ "$GOT_DN" = "cdkrd revert original" ] || fail "DisplayName not restored: $GOT_DN"
[ "$GOT_SV" = "2" ] || fail "SignatureVersion not restored: $GOT_SV"
[ "$GOT_TC" = "Active" ] || fail "TracingConfig not restored: $GOT_TC"
[ "$GOT_KMS" != "alias/aws/sns" ] || fail "KmsMasterKeyId not restored: still $GOT_KMS"

echo "INTEG PASS ($STACK — all 4 SNS Topic attributes revert via Cloud Control)"

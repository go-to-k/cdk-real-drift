#!/usr/bin/env bash
# added-pack-hunt (2026-08-03): live added-direction proof for six OLDER child
# enumerators that had unit tests only (S3 BucketPolicy, SQS QueuePolicy,
# SecretsManager ResourcePolicy, Route53 RecordSet, EC2 NetworkAclEntry,
# Glue Table). Deploy parents child-less -> first check CLEAN -> record ->
# OOB-create all six children -> ALL must surface as `added` -> revert
# (--remove-unrecorded) deletes five (NetworkAclEntry is notRevertable by design,
# #1405 — removed manually) -> CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0803AddedPack
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
BUCKET=cdkrd-hunt-addedpack-0803-x9z7q
GLUE_DB=cdkrd_hunt_addedpack_0803

cleanup() {
  echo "--- cleanup ($STACK) ---"
  aws s3api delete-bucket-policy --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 || true
  aws glue delete-table --database-name "$GLUE_DB" --name cdkrd_oob_table --region "$REGION" >/dev/null 2>&1 || true
  if [ -n "${ZONE_ID:-}" ]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":{\"Name\":\"oob.cdkrd-hunt-0803-x9z7q.com.\",\"Type\":\"A\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"192.0.2.1\"}]}}]}" >/dev/null 2>&1 || true
  fi
  if [ -n "${NACL_ID:-}" ]; then
    aws ec2 delete-network-acl-entry --network-acl-id "$NACL_ID" --rule-number 123 --ingress --region "$REGION" >/dev/null 2>&1 || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+ \(AWS::' || true
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NACL_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?LogicalResourceId=='HuntNacl'].PhysicalResourceId|[0]" --output text)
ZONE_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::Route53::HostedZone'].PhysicalResourceId|[0]" --output text)
QUEUE_URL=$(aws sqs get-queue-url --queue-name cdkrd-hunt-addedpack-0803 --region "$REGION" --query QueueUrl --output text)

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-added-pack}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] OOB-create all six children ==="
# Harmless policies: Deny scoped to a principal-account that never matches, or an
# Allow to this account's own root (already implied).
aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"cdkrdoob\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"aws:PrincipalAccount\":\"000000000000\"}}}]}" || fail "oob put-bucket-policy"
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" --attributes "{\"Policy\":\"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Sid\\\":\\\"cdkrdoob\\\",\\\"Effect\\\":\\\"Deny\\\",\\\"Principal\\\":\\\"*\\\",\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"*\\\",\\\"Condition\\\":{\\\"StringEquals\\\":{\\\"aws:PrincipalAccount\\\":\\\"000000000000\\\"}}}]}\"}" || fail "oob set-queue-attributes Policy"
aws secretsmanager put-resource-policy --secret-id cdkrd-hunt-addedpack-0803 --region "$REGION" --resource-policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"cdkrdoob\",\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::$ACCOUNT:root\"},\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"*\"}]}" >/dev/null || fail "oob put-resource-policy"
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{\"Changes\":[{\"Action\":\"CREATE\",\"ResourceRecordSet\":{\"Name\":\"oob.cdkrd-hunt-0803-x9z7q.com.\",\"Type\":\"A\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"192.0.2.1\"}]}}]}" >/dev/null || fail "oob route53 record"
aws ec2 create-network-acl-entry --network-acl-id "$NACL_ID" --rule-number 123 --protocol -1 --rule-action allow --ingress --cidr-block 10.99.0.0/16 --region "$REGION" || fail "oob create-network-acl-entry"
aws glue create-table --database-name "$GLUE_DB" --region "$REGION" --table-input '{"Name":"cdkrd_oob_table","StorageDescriptor":{"Columns":[{"Name":"c1","Type":"string"}]}}' || fail "oob glue create-table"

echo "=== [$STACK] check MUST surface all six OOB children as added ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.oob.out"
grep -q "AWS::S3::BucketPolicy" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB bucket policy not surfaced as added"
grep -q "AWS::SQS::QueuePolicy" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB queue policy not surfaced as added"
grep -q "AWS::SecretsManager::ResourcePolicy" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB secret resource policy not surfaced as added"
grep -q "oob.cdkrd-hunt-0803-x9z7q.com" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB Route53 record not surfaced as added"
grep -q "AWS::EC2::NetworkAclEntry" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB NACL entry not surfaced as added"
grep -q "cdkrd_oob_table" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB Glue table not surfaced as added"

echo "=== [$STACK] revert (--remove-unrecorded) MUST delete five children (NACL entry is notRevertable) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out"
aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 && fail "bucket policy still present after revert"
aws glue get-table --database-name "$GLUE_DB" --name cdkrd_oob_table --region "$REGION" >/dev/null 2>&1 && fail "glue table still present after revert"
aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --query "ResourceRecordSets[?Name=='oob.cdkrd-hunt-0803-x9z7q.com.']" --output text | grep -q oob && fail "route53 record still present after revert"

echo "=== [$STACK] remove the notRevertable NACL entry manually -> CLEAN ==="
aws ec2 delete-network-acl-entry --network-acl-id "$NACL_ID" --rule-number 123 --ingress --region "$REGION" || fail "manual NACL entry delete"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN at end"

echo "INTEG PASS ($STACK)"

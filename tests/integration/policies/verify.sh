#!/usr/bin/env bash
# cdkrd SDK-WRITER integration test (real AWS, AWS-mutating). Exercises ALL FIVE
# SDK_WRITERS end-to-end (src/revert/writers.ts):
#   AWS::S3::BucketPolicy / AWS::SNS::TopicPolicy / AWS::SQS::QueuePolicy /
#   AWS::IAM::Policy / AWS::IAM::ManagedPolicy
# Flow: deploy -> record (baseline) -> check CLEAN -> inject a "CdkrdInjected"
# statement into every policy document out-of-band -> check DETECTS 5 declared
# drifts -> revert --yes (SDK writers) -> check CLEAN -> AWS direct reads confirm
# the injected statement is GONE while the declared one survived -> destroy.
# Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkdriftIntegPolicies
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

# Append a statement to a policy document (both passed as JSON strings).
splice() {
  node -e '
    const doc = JSON.parse(process.argv[1]);
    const stmt = JSON.parse(process.argv[2]);
    doc.Statement = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
    doc.Statement.push(stmt);
    process.stdout.write(JSON.stringify(doc));
  ' "$1" "$2"
}

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text
}
BUCKET="$(phys 'AWS::S3::Bucket')"
TOPIC_ARN="$(phys 'AWS::SNS::Topic')"
QUEUE_URL="$(phys 'AWS::SQS::Queue')"
MANAGED_ARN="$(phys 'AWS::IAM::ManagedPolicy')"
ROLE_NAME="$(phys 'AWS::IAM::Role')"
# The CFn physical id of AWS::IAM::Policy is an OPAQUE generated string, NOT the
# policy name on the role (declared PolicyName=WorkerInline..., physical id =
# Cdkdr-Worke-...) — GetRolePolicy by physical id was NoSuchEntity on the first
# live run (R69). The fixture role carries exactly one inline policy; ask IAM.
INLINE_NAME="$(aws iam list-role-policies --role-name "$ROLE_NAME" \
  --query 'PolicyNames[0]' --output text)"
for v in BUCKET TOPIC_ARN QUEUE_URL INLINE_NAME MANAGED_ARN ROLE_NAME; do
  [ -n "${!v}" ] || fail "could not resolve $v"
done
QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn \
  --region "$REGION" --query 'Attributes.QueueArn' --output text)"

echo "=== record (baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"

echo "=== inject a CdkrdInjected statement into all 5 policy documents ==="
# S3 bucket policy (Deny is always writable under BlockPublicPolicy; harmless action)
DOC="$(aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" --query Policy --output text)"
aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy \
  "$(splice "$DOC" "{\"Sid\":\"CdkrdInjected\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:GetBucketTagging\",\"Resource\":\"arn:aws:s3:::$BUCKET\"}")" \
  || fail "inject bucket policy"
# SNS topic policy
DOC="$(aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --query 'Attributes.Policy' --output text)"
aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --attribute-name Policy --attribute-value \
  "$(splice "$DOC" "{\"Sid\":\"CdkrdInjected\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudwatch.amazonaws.com\"},\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC_ARN\"}")" \
  || fail "inject topic policy"
# SQS queue policy
DOC="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names Policy --region "$REGION" --query 'Attributes.Policy' --output text)"
NEWDOC="$(splice "$DOC" "{\"Sid\":\"CdkrdInjected\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"events.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$QUEUE_ARN\"}")"
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" \
  --attributes "$(node -e 'process.stdout.write(JSON.stringify({Policy: process.argv[1]}))' "$NEWDOC")" \
  || fail "inject queue policy"
# IAM inline policy (AWS::IAM::Policy — put-role-policy overwrites by name)
DOC="$(aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$INLINE_NAME" --query PolicyDocument --output json)"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$INLINE_NAME" --policy-document \
  "$(splice "$DOC" '{"Sid":"CdkrdInjected","Effect":"Allow","Action":"s3:GetBucketLocation","Resource":"*"}')" \
  || fail "inject inline policy"
# IAM managed policy (new default version)
VER="$(aws iam get-policy --policy-arn "$MANAGED_ARN" --query 'Policy.DefaultVersionId' --output text)"
DOC="$(aws iam get-policy-version --policy-arn "$MANAGED_ARN" --version-id "$VER" --query 'PolicyVersion.Document' --output json)"
aws iam create-policy-version --policy-arn "$MANAGED_ARN" --set-as-default --policy-document \
  "$(splice "$DOC" '{"Sid":"CdkrdInjected","Effect":"Allow","Action":"s3:GetBucketLocation","Resource":"*"}')" \
  || fail "inject managed policy"
echo "(waiting for IAM/SQS propagation)"; sleep 15

echo "=== check DETECTS all 5 declared drifts ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-policies-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
for name in "Data/Policy" "EventsPolicy" "JobsPolicy" "WorkerInline" "WorkerManaged"; do
  grep -q "$name" /tmp/cdkrd-policies-pre.out || fail "$name drift not reported"
done

echo "=== revert --yes (all 5 SDK writers) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert returned non-zero"

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert"

echo "=== belt-and-suspenders: injected statement gone, declared statement survived ==="
sleep 5
aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" --query Policy --output text > /tmp/cdkrd-pol-s3.json
grep -q "CdkrdInjected" /tmp/cdkrd-pol-s3.json && fail "bucket policy still injected"
grep -q "DenyInsecureTransport" /tmp/cdkrd-pol-s3.json || fail "bucket policy lost its declared statement"
aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --query 'Attributes.Policy' --output text | grep -q "CdkrdInjected" && fail "topic policy still injected"
aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names Policy --region "$REGION" --query 'Attributes.Policy' --output text | grep -q "CdkrdInjected" && fail "queue policy still injected"
aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$INLINE_NAME" --query PolicyDocument --output json | grep -q "CdkrdInjected" && fail "inline policy still injected"
VER="$(aws iam get-policy --policy-arn "$MANAGED_ARN" --query 'Policy.DefaultVersionId' --output text)"
aws iam get-policy-version --policy-arn "$MANAGED_ARN" --version-id "$VER" --query 'PolicyVersion.Document' --output json | grep -q "CdkrdInjected" && fail "managed policy still injected"

echo "INTEG PASS"

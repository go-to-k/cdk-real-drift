#!/usr/bin/env bash
# cdk-real-drift multi-type MUTATION integration test (real AWS, R91).
#
# The false-NEGATIVE guard: deploy 5 types, record (baseline CLEAN), then change one
# declared property on each out of band and assert `check --fail` DETECTS every one.
# A normalizer that wrongly collapses a real change would make cdkrd miss it and
# report CLEAN — this catches that. A cleanup trap destroys even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/mutation-multi && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMutation
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

phys() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record then check must be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== mutate one declared property on each type out of band ==="
Q="$(phys AWS::SQS::Queue)";        [ -n "$Q" ] || fail "no queue url"
T="$(phys AWS::SNS::Topic)";        [ -n "$T" ] || fail "no topic arn"
FN="$(phys AWS::Lambda::Function)"; [ -n "$FN" ] || fail "no function name"
B="$(phys AWS::S3::Bucket)";        [ -n "$B" ] || fail "no bucket name"
R="$(phys AWS::ECR::Repository)";   [ -n "$R" ] || fail "no repo name"

aws sqs set-queue-attributes --queue-url "$Q" --attributes VisibilityTimeout=60 --region "$REGION" || fail "mutate sqs"
aws sns set-topic-attributes --topic-arn "$T" --attribute-name DisplayName --attribute-value changed-name --region "$REGION" || fail "mutate sns"
aws lambda update-function-configuration --function-name "$FN" --timeout 30 --region "$REGION" >/dev/null || fail "mutate lambda"
aws lambda wait function-updated --function-name "$FN" --region "$REGION" || true
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Suspended --region "$REGION" || fail "mutate s3"
aws ecr put-image-tag-mutability --repository-name "$R" --image-tag-mutability MUTABLE --region "$REGION" >/dev/null || fail "mutate ecr"
sleep 5

echo "=== check must DETECT every mutation (exit 1 + each property named) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mutation.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc — a mutation was MISSED (false negative)"
for prop in VisibilityTimeout DisplayName Timeout VersioningConfiguration ImageTagMutability; do
  grep -q "$prop" /tmp/cdkrd-mutation.out || fail "$prop mutation NOT detected — false negative"
done

echo "INTEG PASS"

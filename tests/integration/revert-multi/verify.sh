#!/usr/bin/env bash
# cdk-real-drift multi-type REVERT integration test (real AWS, R92).
#
# Exercises the one AWS-mutating path across five types via Cloud Control
# UpdateResource: deploy, accept (CLEAN baseline), change one declared property on
# each out of band, then `revert --yes` and assert the stack converges to CLEAN AND
# every live value is restored to its template value. A cleanup trap destroys even
# on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/revert-multi && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRevertMulti
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
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

echo "=== deploy + accept (baseline CLEAN) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
$CLI accept "$STACK" --region "$REGION" --yes || fail "accept"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after accept"

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

echo "=== drift must be present before revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 1 ] || fail "expected drift exit 1 before revert"

echo "=== revert --yes must write the template values back to AWS ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert returned non-zero"

echo "=== check must be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert"

echo "=== verify every live value was restored to the template value ==="
v="$(aws sqs get-queue-attributes --queue-url "$Q" --attribute-names VisibilityTimeout --region "$REGION" --query 'Attributes.VisibilityTimeout' --output text)"
[ "$v" = "30" ] || fail "SQS VisibilityTimeout not restored (got $v)"
v="$(aws sns get-topic-attributes --topic-arn "$T" --region "$REGION" --query 'Attributes.DisplayName' --output text)"
[ "$v" = "original-name" ] || fail "SNS DisplayName not restored (got $v)"
v="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" --query 'Timeout' --output text)"
[ "$v" = "10" ] || fail "Lambda Timeout not restored (got $v)"
v="$(aws s3api get-bucket-versioning --bucket "$B" --region "$REGION" --query 'Status' --output text)"
[ "$v" = "Enabled" ] || fail "S3 versioning not restored (got $v)"
v="$(aws ecr describe-repositories --repository-names "$R" --region "$REGION" --query 'repositories[0].imageTagMutability' --output text)"
[ "$v" = "IMMUTABLE" ] || fail "ECR ImageTagMutability not restored (got $v)"

echo "INTEG PASS"

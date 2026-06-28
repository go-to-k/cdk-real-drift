#!/usr/bin/env bash
# ECS Service ServiceConnectConfiguration writeOnly-read-gap integration test (real AWS).
#
# AWS::ECS::Service `ServiceConnectConfiguration` is writeOnly — Cloud Control echoes
# the service's other props but never the Service Connect config (it lives on the
# service's deployments), so an out-of-band change to the Service Connect wiring was
# silently invisible. The SDK_SUPPLEMENTS reader reconstructs it from the PRIMARY
# deployment (PascalCased; DiscoveryName==PortName default folded); the declared
# namespace `Fn::GetAtt` resolves because the new ServiceDiscovery PrivateDnsNamespace
# override now exposes its Arn in liveAttrs. This test proves: clean record -> check is
# CLEAN (no FP), an out-of-band change to a Service Connect client-alias DnsName is
# DETECTED, and revert restores it (CC cannot sub-path patch a writeOnly prop, so revert
# re-supplies the whole declared config via the ecs:UpdateService SDK_NESTED_WRITER).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEcsServiceConnectReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

CLUSTER=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId | [0]" --output text)
SVC=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Service'].PhysicalResourceId | [0]" --output text)
NSID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ServiceDiscovery::PrivateDnsNamespace'].PhysicalResourceId | [0]" --output text)
NSARN=$(aws servicediscovery get-namespace --id "$NSID" --region "$REGION" --query 'Namespace.Arn' --output text)
[ -n "$SVC" ] && [ "$SVC" != "None" ] || fail "could not resolve ECS service"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN (namespace GetAtt resolves; SC reconstruction matches) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.clean.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] mutate a Service Connect client-alias DnsName out of band ==="
cat > /tmp/cdkrd-ecs-upd.json <<JSON
{"cluster":"$CLUSTER","service":"$SVC","serviceConnectConfiguration":{"enabled":true,"namespace":"$NSARN","services":[{"portName":"api","clientAliases":[{"port":8080,"dnsName":"api-tampered"}]}]}}
JSON
aws ecs update-service --cli-input-json file:///tmp/cdkrd-ecs-upd.json --region "$REGION" >/dev/null || fail "update-service"
sleep 12

echo "=== [$STACK] check MUST DETECT the Service Connect DnsName drift (no false negative) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.drift.out"
rc=${PIPESTATUS[0]}
[ "$rc" -ne 0 ] || { echo "--- FALSE NEGATIVE: ServiceConnect change not detected ---"; fail "expected drift (exit 1), got $rc"; }
grep -q "ServiceConnectConfiguration" "/tmp/cdkrd-$STACK.drift.out" || fail "drift output does not mention ServiceConnectConfiguration"

echo "=== [$STACK] revert (re-supplies the declared Service Connect config via UpdateService) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qi "reverted:" "/tmp/cdkrd-$STACK.revert.out" || fail "revert did not run the UpdateService writer"
grep -qi "CLEAN after revert" "/tmp/cdkrd-$STACK.revert.out" || fail "revert did not converge (cdkrd re-read still drifts)"
sleep 20

echo "=== [$STACK] check MUST be CLEAN again after revert (authoritative end-to-end) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert (exit 0), got $rc"

echo "INTEG PASS ($STACK)"

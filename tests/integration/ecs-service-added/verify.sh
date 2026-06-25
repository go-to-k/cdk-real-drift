#!/usr/bin/env bash
# cdk-real-drift `added` integ test for ECS (the TWELFTH CHILD_ENUMERATORS member).
#   deploy fixture (minimal VPC + ECS cluster + Fargate task def + a CDK service) ->
#      record -> CLEAN
#   -> create-service an undeclared service on the SAME cluster out of band -> check
#      reports the service under [Potential Drift] and is NOT drift (exit 0) -> `record`
#      snapshots it (proves CC GetResource + normalize for AWS::ECS::Service) -> CLEAN
#   -> add ANOTHER out-of-band service -> `revert --remove-unrecorded` DELETES it via Cloud
#      Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap force-deletes
# the out-of-band services off the cluster FIRST (else they block the cluster's deletion ->
# the stack goes DELETE_FAILED) and then destroys the stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/ecs-service-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEcsServiceAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OOB1=cdkrd-integ-oob-record
OOB2=cdkrd-integ-oob-revert

stack_resource() { # $1 = ResourceType -> echoes the first PhysicalResourceId
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null
}

cleanup() {
  echo "--- cleanup ---"
  # An out-of-band service we recorded (but did not revert) lingers on the cluster and
  # BLOCKS the cluster's deletion (CFn cannot delete a cluster that still has active
  # services) -> the stack goes DELETE_FAILED, and delstack only sees STACK members, not a
  # stack-external service running on a member cluster. So force-delete any out-of-band
  # services (the cdkrd-integ-oob-* ones) off the cluster FIRST.
  local cluster
  cluster="$(stack_resource 'AWS::ECS::Cluster')"
  if [ -n "$cluster" ] && [ "$cluster" != "None" ]; then
    for svc_arn in $(aws ecs list-services --cluster "$cluster" --region "$REGION" \
      --query 'serviceArns[]' --output text 2>/dev/null); do
      local name="${svc_arn##*/}"
      case "$name" in
        cdkrd-integ-oob-*)
          aws ecs delete-service --cluster "$cluster" --service "$name" --force \
            --region "$REGION" >/dev/null 2>&1 || true
          ;;
      esac
    done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_service() { # $1 = service-name -> creates a Fargate service (desiredCount 0)
  aws ecs create-service --cluster "$CLUSTER" --service-name "$1" \
    --task-definition "$TASKDEF" --desired-count 0 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --region "$REGION" >/dev/null || fail "create-service $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared service NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

# Resolve the pieces needed to inject an out-of-band service into the cluster.
CLUSTER="$(stack_resource 'AWS::ECS::Cluster')"
[ -n "$CLUSTER" ] && [ "$CLUSTER" != "None" ] || fail "could not resolve cluster name"
TASKDEF="$(stack_resource 'AWS::ECS::TaskDefinition')"
[ -n "$TASKDEF" ] && [ "$TASKDEF" != "None" ] || fail "could not resolve task definition arn"
SUBNET="$(stack_resource 'AWS::EC2::Subnet')"
[ -n "$SUBNET" ] && [ "$SUBNET" != "None" ] || fail "could not resolve a public subnet id"
VPC="$(stack_resource 'AWS::EC2::VPC')"
[ -n "$VPC" ] && [ "$VPC" != "None" ] || fail "could not resolve VPC id"
SG="$(stack_resource 'AWS::EC2::SecurityGroup')"
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  # No stack SG (the FargateService may reuse the VPC default SG): use the VPC default SG.
  SG="$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC" "Name=group-name,Values=default" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)"
fi
[ -n "$SG" ] && [ "$SG" != "None" ] || fail "could not resolve a security group id"

echo "=== create an undeclared service on the cluster out of band ==="
inject_service "$OOB1"

echo "=== check reports the service as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ecs.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-ecs.out || fail "added service not under [Potential Drift]"
grep -q "AWS::ECS::Service" /tmp/cdkrd-integ-ecs.out || fail "the out-of-band service not reported"
grep -q "added=" /tmp/cdkrd-integ-ecs.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added service (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for ECS::Service) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ecs-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added service, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-ecs-clean.out && fail "still Not-Recorded after record (GetResource likely failed; switch the identifier cluster-half to the cluster ARN)" || true

echo "=== add ANOTHER out-of-band service for the revert path ==="
inject_service "$OOB2"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-ecs-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-ecs-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-ecs-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-ecs-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second service must be gone (INACTIVE or absent) from AWS ==="
STATUS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$OOB2" --region "$REGION" \
  --query 'services[0].status' --output text 2>/dev/null)"
if [ "$STATUS" != "INACTIVE" ] && [ -n "$STATUS" ] && [ "$STATUS" != "None" ]; then
  fail "the reverted service still exists (status=$STATUS; delete did not take effect)"
fi

echo "INTEG PASS"

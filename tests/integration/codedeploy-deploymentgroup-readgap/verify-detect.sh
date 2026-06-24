#!/usr/bin/env bash
# DeploymentGroup detect + revert integration test (real AWS): the false-NEGATIVE
# half. Deploy -> record -> change the DECLARED MUTABLE DeploymentConfigName out of
# band (console-edit scenario via update-deployment-group) -> check MUST DETECT the
# declared drift (exit 1) -> revert (Cloud Control UpdateResource) -> check MUST be
# CLEAN and the live DeploymentConfigName MUST be restored. This also exercises that
# the read-gap fix actually reads the group (a `skipped` group could never detect).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodeDeployDeploymentGroupReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

APP="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::CodeDeploy::Application'].PhysicalResourceId" --output text)"
DG=cdkrd-readgap-dg
[ -n "$APP" ] || fail "could not resolve application name"

ORIG="$(aws deploy get-deployment-group --application-name "$APP" --deployment-group-name "$DG" \
  --region "$REGION" --query "deploymentGroupInfo.deploymentConfigName" --output text)"
echo "app=$APP dg=$DG origConfig=[$ORIG]"
[ "$ORIG" = "CodeDeployDefault.OneAtATime" ] || fail "unexpected original config: $ORIG"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change DeploymentConfigName (console-edit) ==="
aws deploy update-deployment-group --application-name "$APP" \
  --current-deployment-group-name "$DG" \
  --deployment-config-name "CodeDeployDefault.AllAtOnce" \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-codedeploy-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "DeploymentConfigName" /tmp/cdkrd-codedeploy-detect.out || fail "DeploymentConfigName not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live DeploymentConfigName MUST be restored ==="
GOT="$(aws deploy get-deployment-group --application-name "$APP" --deployment-group-name "$DG" \
  --region "$REGION" --query "deploymentGroupInfo.deploymentConfigName" --output text)"
[ "$GOT" = "$ORIG" ] || fail "live DeploymentConfigName not restored (got: [$GOT], want: [$ORIG])"

echo "INTEG PASS ($STACK detect+revert)"

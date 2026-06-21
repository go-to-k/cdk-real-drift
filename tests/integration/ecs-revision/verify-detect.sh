#!/usr/bin/env bash
# ECS task-def revision detect + revert (real AWS): the "someone updated the task def
# in the console" scenario. Register a NEW task-def revision out of band and repoint
# the service to it -> the Service's declared TaskDefinition pointer (family:1 ->
# family:2) MUST be detected as declared drift -> revert repoints back to :1.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegEcsRevision; CLUSTER=cdkrd-ecs-revision; SVC=cdkrd-ecs-revision-svc
REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; aws ecs deregister-task-definition --task-definition "${NEWTD:-none}" --region "$REGION" >/dev/null 2>&1 || true; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out td.json td2.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
CURTD="$(aws ecs describe-services --cluster $CLUSTER --services $SVC --region $REGION --query 'services[0].taskDefinition' --output text)"
aws ecs describe-task-definition --task-definition "$CURTD" --region $REGION --query taskDefinition > td.json
node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('td.json'));for(const k of ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy'])delete t[k];t.containerDefinitions[0].environment=[{name:'DRIFT',value:'v2'}];fs.writeFileSync('td2.json',JSON.stringify(t));"
NEWTD="$(aws ecs register-task-definition --cli-input-json file://td2.json --region $REGION --query taskDefinition.taskDefinitionArn --output text)"
echo "=== oob repoint service to $NEWTD ==="
aws ecs update-service --cluster $CLUSTER --service $SVC --task-definition "$NEWTD" --region $REGION >/dev/null || fail "repoint"
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ecsrev-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "TaskDefinition" /tmp/cdkrd-ecsrev-detect.out || fail "TaskDefinition pointer drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
sleep 5
echo "=== check CLEAN after revert ==="; $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
GOT="$(aws ecs describe-services --cluster $CLUSTER --services $SVC --region $REGION --query 'services[0].taskDefinition' --output text)"
echo "$GOT" | grep -q ':1$' || fail "service not repointed to :1 (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

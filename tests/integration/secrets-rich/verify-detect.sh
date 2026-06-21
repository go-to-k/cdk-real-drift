#!/usr/bin/env bash
# Secrets Manager Secret detect + revert (real AWS): flip the declared MUTABLE
# Description out of band (update-secret) -> check MUST DETECT -> revert (CC) -> CLEAN
# + restored. (Revert via Cloud Control UpdateResource.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegSecretsRich; DESIRED="rich secret fixture for cdk-real-drift"; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
SID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId" --output text | head -1)"
[ -n "$SID" ] && [ "$SID" != "None" ] || fail "no secret id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob Description -> DRIFTED ==="
aws secretsmanager update-secret --secret-id "$SID" --description "DRIFTED DESC" --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-secrets-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Description" /tmp/cdkrd-secrets-detect.out || fail "Description drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws secretsmanager describe-secret --secret-id "$SID" --region "$REGION" --query Description --output text)"
[ "$GOT" = "$DESIRED" ] || fail "Description not restored (got: $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

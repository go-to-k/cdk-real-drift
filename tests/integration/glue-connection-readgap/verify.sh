#!/usr/bin/env bash
# Read-gap + FP: deploy -> check (connection must NOT be skipped) -> record -> check CLEAN.
# Env-bound stack so the NETWORK connection's required AvailabilityZone resolves CONCRETELY
# (an env-agnostic Fn::GetAZs token would mark the whole ConnectionInput `unresolved`).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueConnectionReadgap; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
echo "=== check BEFORE record (connection must NOT be skipped) ==="; $CLI check "$STACK" --region "$REGION" --verbose | tee "/tmp/cdkrd-$STACK.pre"
grep -qi "Conn.*UnsupportedActionException" "/tmp/cdkrd-$STACK.pre" && fail "connection still skipped"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== check MUST be CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE ---"; fail "expected CLEAN, got $rc"; }

# --- revert path (credential-safe glue:UpdateConnection SDK writer) ---
# Mutate a DECLARED prop (ConnectionInput.Description) out of band on the NETWORK connection
# (no inline credential -> the safe case), confirm `check` DETECTS it, `revert` writes the
# declared value back, and a re-check is CLEAN.
CONN=cdkrd-network-conn
echo "=== mutate ConnectionInput.Description out of band ==="
aws glue get-connection --name "$CONN" --region "$REGION" --query 'Connection' --output json \
  | jq '{Name:.Name, ConnectionType:.ConnectionType, ConnectionProperties:(.ConnectionProperties // {}), PhysicalConnectionRequirements:.PhysicalConnectionRequirements, Description:"drifted out of band"}' \
  > "/tmp/glue-ci-$STACK.json"
aws glue update-connection --name "$CONN" --region "$REGION" \
  --connection-input "file:///tmp/glue-ci-$STACK.json" || fail "inject Description drift"
echo "=== check MUST DETECT the declared drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-drift-$STACK.out"
[ "${PIPESTATUS[0]}" -ne 0 ] || fail "expected drift detected (exit !=0) after Description mutation"
grep -q "ConnectionInput.Description" "/tmp/cdkrd-drift-$STACK.out" || fail "expected ConnectionInput.Description in the drift report"
echo "=== revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-revert-$STACK.out" || fail "revert"
echo "=== post-revert check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-postrevert-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert (glue:UpdateConnection writer)"
echo "INTEG PASS ($STACK)"

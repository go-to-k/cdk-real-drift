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
echo "INTEG PASS ($STACK)"

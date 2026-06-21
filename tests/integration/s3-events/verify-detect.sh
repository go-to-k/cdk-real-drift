#!/usr/bin/env bash
# S3 detect + revert (real AWS): flip the declared MUTABLE transfer-acceleration
# Enabled->Suspended out of band -> check MUST DETECT -> revert -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegS3Events; BUCKET=cdkrd-s3-events-fixture; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob accel Enabled->Suspended ==="
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" --accelerate-configuration Status=Suspended --region "$REGION" || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-s3ev-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Accelerat" /tmp/cdkrd-s3ev-detect.out || fail "acceleration drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws s3api get-bucket-accelerate-configuration --bucket "$BUCKET" --region "$REGION" --query Status --output text)"
[ "$GOT" = "Enabled" ] || fail "acceleration not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

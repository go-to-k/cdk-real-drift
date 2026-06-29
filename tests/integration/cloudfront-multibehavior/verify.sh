#!/usr/bin/env bash
# False-positive integration test (real AWS): a CloudFront distribution with THREE
# path-pattern CacheBehaviors -> record -> check MUST be CLEAN. Probes the untested
# CacheBehaviors ordering gap (PathPattern-keyed object array, absent from UNORDERED_*).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegCloudfrontMulti; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-cfmulti $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true
echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-cfmulti-pre.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || fail "false declared drift on multi-behavior CloudFront (exit $rc)"
grep -q "CFn-Declared Drift" /tmp/cdkrd-cfmulti-pre.out && fail "a declared property wrongly reported as drift (FP)"
echo "=== record then check MUST be CLEAN ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"
echo "INTEG PASS ($STACK)"

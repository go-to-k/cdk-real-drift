#!/usr/bin/env bash
# FP integration test (real AWS): a single-node Memcached CacheCluster (the uncovered
# ElastiCache engine) -> record -> check MUST be CLEAN. Also confirms EngineVersion
# echoes verbatim (no partial->concrete VERSION_PREFIX divergence on the CC-native path).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElasticacheMemcached; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== build ==="; (cd "$ROOT" && vp pack) >/dev/null 2>&1 || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-memcached $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true
echo "=== check --fail (no baseline) must find ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-memcached-pre.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || fail "false declared drift on Memcached CacheCluster (exit $rc)"
grep -q "CFn-Declared Drift" /tmp/cdkrd-memcached-pre.out && fail "a declared property wrongly reported as drift (FP)"
echo "=== record then check MUST be CLEAN ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"
echo "INTEG PASS ($STACK)"

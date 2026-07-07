#!/usr/bin/env bash
# FP integration test (real AWS): an ElastiCache ParameterGroup declaring two non-default
# parameters -> check BEFORE record MUST show ZERO undeclared drift (the ~60 inherited
# engine defaults must fold away via the source=user SDK reader), and record -> check MUST
# be CLEAN. A ParameterGroup provisions nothing billable and is instant.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegElasticacheParamGroup; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== build ==="; (cd "$ROOT" && vp pack) >/dev/null 2>&1 || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-ecpg $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true
echo "=== check --fail BEFORE record must find ZERO drift (no default-fill FP) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ecpg-pre.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || fail "first-run drift on clean ParameterGroup (exit $rc) — default-fill FP"
echo "=== record then check MUST be CLEAN ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"
echo "INTEG PASS ($STACK)"

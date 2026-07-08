#!/usr/bin/env bash
# Integration test (real AWS): the MemoryDB CloudFormation provider does NOT apply a declared
# ParameterGroup's Parameters on CREATE (it applies them only on a later UPDATE — verified on a
# raw non-CDK template; AWS drift detection is blind because Parameters is writeOnly). The
# SDK_SUPPLEMENTS reader makes cdkrd read the live parameters, so a fresh deploy DETECTS the
# never-applied declared parameters (previously an invisible writeOnly readGap), and `revert`
# materializes them via UpdateParameterGroup — the very call the provider skipped. Follow-up to
# the ElastiCache ParameterGroup fix (#612). A ParameterGroup provisions nothing billable.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegMemoryDbParamGroup; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== build ==="; (cd "$ROOT" && vp pack) >/dev/null 2>&1 || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== harvest corpus (fresh deploy, no baseline) ==="
CDKRD_CORPUS_DIR=/tmp/corpus-mdbpg $CLI check "$STACK" --region "$REGION" >/dev/null 2>&1 || true
echo "=== check --fail MUST DETECT the CFn-never-applied declared params (previously readGap) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-mdbpg.out
rc=${PIPESTATUS[0]}
grep -q "Parameters.maxmemory-policy" /tmp/cdkrd-mdbpg.out || fail "expected to detect the never-applied declared parameters"
[ "$rc" -ne 0 ] || fail "expected drift exit (the never-applied params) but got 0"
echo "=== revert --yes MUST apply the declared params (UpdateParameterGroup) and converge CLEAN ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail revert
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after revert applied the declared params"
echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# cdk-real-drift AWS::CodeBuild::Project projection FALSE-NEGATIVE integration test.
#
# The CodeBuild SDK-override reader projected a thin model that OMITTED ConcurrentBuildLimit,
# VpcConfig, Visibility, and SourceVersion — so an out-of-band change to them was
# undetectable (a declared one became a benign readGap). The fix adds them. This deploys a
# PipelineProject declaring concurrentBuildLimit=1, asserts CLEAN after record (FP guard:
# the now-read Visibility=PRIVATE folds to atDefault, VpcConfig is omitted), then bumps
# the limit out of band and asserts cdkrd DETECTS it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodeBuild
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy PipelineProject (concurrentBuildLimit=1) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::CodeBuild::Project'].PhysicalResourceId" --output text)"
[ -n "$NAME" ] || fail "could not resolve project name"
echo "project=$NAME"

echo "=== record + check should be CLEAN (FP guard: Visibility=PRIVATE folds to atDefault) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after record — a newly-read field (Visibility/VpcConfig) leaked as drift?"

echo "=== bump ConcurrentBuildLimit out of band (1 -> 5) ==="
aws codebuild update-project --name "$NAME" --concurrent-build-limit 5 --region "$REGION" >/dev/null \
  || fail "update-project"

echo "=== check MUST now DETECT the ConcurrentBuildLimit change (was projected away) ==="
OUT=/tmp/cdkrd-codebuild-check.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 (ConcurrentBuildLimit change must be detected), got $rc"
grep -qi "ConcurrentBuildLimit" "$OUT" || fail "ConcurrentBuildLimit change not reported — still projected away?"

echo "INTEG PASS"

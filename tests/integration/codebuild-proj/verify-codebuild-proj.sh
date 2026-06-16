#!/usr/bin/env bash
# cdk-real-drift AWS::CodeBuild::Project projection FALSE-NEGATIVE integration test.
#
# The CodeBuild SDK-override reader projected a thin model that OMITTED ConcurrentBuildLimit,
# VpcConfig, Visibility, SourceVersion, LogsConfig, and BadgeEnabled — so an out-of-band
# change to them was undetectable (a declared one became a benign readGap). The fix adds
# them. This deploys a PipelineProject declaring concurrentBuildLimit=1 and NO logging,
# asserts CLEAN after record (FP guard: the now-read Visibility=PRIVATE folds to atDefault,
# VpcConfig/LogsConfig are omitted when unset, BadgeEnabled=false is trivially-empty), then
# (1) bumps the limit out of band and (2) enables a custom CloudWatch log group out of band,
# asserting cdkrd DETECTS both.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodeBuild
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
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

echo "=== set logsConfig out of band (project declared NO logging) — must DETECT it ==="
# LogsConfig was projected away entirely, so an out-of-band logging redirect was invisible.
# The project declared no logging (live logsConfig=null at record), so enabling a custom
# CloudWatch log group out of band must surface as a NEW undeclared LogsConfig finding.
aws codebuild update-project --name "$NAME" --region "$REGION" \
  --logs-config '{"cloudWatchLogs":{"status":"ENABLED","groupName":"cdkrd-oob-logs"}}' >/dev/null \
  || fail "update-project logs"
OUT2=/tmp/cdkrd-codebuild-logs.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT2"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for out-of-band LogsConfig, got $rc"
grep -qi "LogsConfig" "$OUT2" || fail "out-of-band LogsConfig not reported — still projected away?"

echo "INTEG PASS"

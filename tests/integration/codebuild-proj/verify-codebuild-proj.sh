#!/usr/bin/env bash
# cdk-real-drift AWS::CodeBuild::Project projection FALSE-NEGATIVE integration test.
#
# The CodeBuild SDK-override reader projected a thin model that OMITTED ConcurrentBuildLimit,
# VpcConfig, Visibility, SourceVersion, LogsConfig, BadgeEnabled, and the security flags
# Artifacts.EncryptionDisabled / Source.InsecureSsl / Source.ReportBuildStatus — so an
# out-of-band change to them was undetectable (a declared one became a benign readGap). The
# fix adds them. This deploys an S3-sourced Project declaring concurrentBuildLimit=1, artifact
# encryption ON, and NO logging; asserts CLEAN after record (FP guard: Visibility=PRIVATE
# folds to atDefault, LogsConfig omitted when unset, BadgeEnabled=false and
# Artifacts.EncryptionDisabled=false are trivially-empty, Source.InsecureSsl/ReportBuildStatus
# absent for an S3 source); then (1) bumps the limit, (2) enables a custom CloudWatch log
# group, and (3) turns OFF artifact encryption — all out of band — asserting cdkrd DETECTS all.
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

echo "=== deploy S3-sourced Project (concurrentBuildLimit=1, artifact encryption ON) ==="
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

echo "=== turn OFF artifact encryption out of band — must DETECT Artifacts.EncryptionDisabled ==="
# EncryptionDisabled was projected away, so disabling artifact encryption (a security
# regression) was invisible. The project deployed with encryption ON (EncryptionDisabled
# absent/false → folded at record). Flip ONLY encryptionDisabled on the existing artifacts
# config (fetch current, set the flag) so the diff is exactly that one security field.
ART="$(aws codebuild batch-get-projects --names "$NAME" --region "$REGION" \
  --query 'projects[0].artifacts' --output json)"
NEW_ART="$(printf '%s' "$ART" | python3 -c 'import sys,json; a=json.load(sys.stdin); a["encryptionDisabled"]=True; print(json.dumps(a))')"
aws codebuild update-project --name "$NAME" --region "$REGION" --artifacts "$NEW_ART" >/dev/null \
  || fail "update-project artifacts"
OUT3=/tmp/cdkrd-codebuild-enc.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT3"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for out-of-band EncryptionDisabled, got $rc"
grep -qi "EncryptionDisabled" "$OUT3" || fail "out-of-band Artifacts.EncryptionDisabled not reported — still projected away?"

echo "INTEG PASS"

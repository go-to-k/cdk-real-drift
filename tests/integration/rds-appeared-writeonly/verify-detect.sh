#!/usr/bin/env bash
# #1582 regression (real AWS): a resource that declares a WRITE-ONLY property (RDS
# MasterUserPassword) must still detect an out-of-band, appeared-since-record change to an
# UNDECLARED property. Before the fix the write-only readGap marked the resource NOT
# `complete`, silently disabling "appeared since record" so the change surfaced only as
# [Not Recorded] and `check --fail` exited 0 (a false negative). After the fix the write-only
# readGap no longer blocks completeness, so the appeared value is [Potential Drift].
# CopyTagsToSnapshot is an online modify (no reboot); poll describe until it propagates.
set -uo pipefail
export AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRdsRevertTwins0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "DETECT FAIL ($STACK): $*"; exit 1; }

echo "=== deploy (RDS ~8 min) ==="
npx cdk deploy -f "$STACK" --require-approval never >/dev/null 2>&1 || fail "deploy"
DBID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].PhysicalResourceId" --output text)"
[ -n "$DBID" ] || fail "could not resolve db id"

echo "=== record clean baseline (CopyTagsToSnapshot folds atDefault=false, not recorded) ==="
$CLI record "$STACK" --region "$REGION" --yes >/dev/null 2>&1 || fail "record"
$CLI check "$STACK" --region "$REGION" --fail >/dev/null 2>&1 || fail "expected CLEAN after record"

echo "=== enable CopyTagsToSnapshot out of band ==="
aws rds modify-db-instance --db-instance-identifier "$DBID" --apply-immediately --copy-tags-to-snapshot --region "$REGION" >/dev/null || fail "modify"
v=""
for _ in $(seq 1 24); do
  v="$(aws rds describe-db-instances --db-instance-identifier "$DBID" --region "$REGION" --query 'DBInstances[0].CopyTagsToSnapshot' --output text)"
  [ "$v" = "True" ] && break
  sleep 5
done
[ "$v" = "True" ] || fail "modify did not propagate"

echo "=== check MUST DETECT the appeared-since-record CopyTagsToSnapshot (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
RC="${PIPESTATUS[0]}"
grep -qi "CopyTagsToSnapshot" "/tmp/cdkrd-$STACK-detect.out" || fail "CopyTagsToSnapshot not in the report"
[ "$RC" -eq 1 ] || fail "check did NOT detect the appeared CopyTagsToSnapshot (#1582 FN)"
echo "DETECT PASS ($STACK)"

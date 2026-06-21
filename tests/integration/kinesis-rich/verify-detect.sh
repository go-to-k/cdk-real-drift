#!/usr/bin/env bash
# Kinesis Stream detect + revert (real AWS): bump the declared MUTABLE
# RetentionPeriodHours 48->72 out of band (increase-stream-retention-period) -> check
# MUST DETECT -> revert (CC) -> CLEAN + restored. (Simple CC type — revert via Cloud
# Control UpdateResource.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegKinesisRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
SN="$(aws kinesis list-streams --region "$REGION" --query "StreamNames[?contains(@,'CdkRealDriftIntegKinesisRich')]" --output text | head -1)"
[ -n "$SN" ] && [ "$SN" != "None" ] || fail "no stream name"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob RetentionPeriodHours 48->72 ==="
aws kinesis increase-stream-retention-period --stream-name "$SN" --retention-period-hours 72 --region "$REGION" >/dev/null || fail inject
sleep 3
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-kinesis-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "RetentionPeriodHours" /tmp/cdkrd-kinesis-detect.out || fail "retention drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
sleep 3
GOT="$(aws kinesis describe-stream-summary --stream-name "$SN" --region "$REGION" --query 'StreamDescriptionSummary.RetentionPeriodHours' --output text)"
[ "$GOT" = "48" ] || fail "retention not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

#!/usr/bin/env bash
# Backup Plan detect + revert (real AWS): bump the declared MUTABLE nested
# BackupPlan rule CompletionWindowMinutes 120->180 out of band (update-backup-plan) ->
# check MUST DETECT -> revert (CC) -> CLEAN + restored. (CC UpdateResource handles the
# nested BackupPlanRule patch cleanly — no Class-2 re-validation conflict.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegBackupRich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out bp.json bpu.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
PID="$(aws backup list-backup-plans --region "$REGION" --query "BackupPlansList[?BackupPlanName=='cdkrd-backup-rich'].BackupPlanId" --output text | head -1)"
[ -n "$PID" ] && [ "$PID" != "None" ] || fail "no backup plan id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob CompletionWindowMinutes 120->180 ==="
aws backup get-backup-plan --backup-plan-id "$PID" --region "$REGION" --query BackupPlan > bp.json
node -e "const p=require('./bp.json');const rules=p.Rules.map(r=>({RuleName:r.RuleName,TargetBackupVaultName:r.TargetBackupVaultName,ScheduleExpression:r.ScheduleExpression,StartWindowMinutes:r.StartWindowMinutes,CompletionWindowMinutes:r.RuleName==='Daily'?180:r.CompletionWindowMinutes,Lifecycle:r.Lifecycle,RecoveryPointTags:r.RecoveryPointTags,EnableContinuousBackup:r.EnableContinuousBackup}));require('fs').writeFileSync('bpu.json',JSON.stringify({BackupPlanName:p.BackupPlanName,Rules:rules}));"
aws backup update-backup-plan --backup-plan-id "$PID" --backup-plan file://bpu.json --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-bk-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "CompletionWindowMinutes" /tmp/cdkrd-bk-detect.out || fail "drift not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail revert
GOT="$(aws backup get-backup-plan --backup-plan-id "$PID" --region "$REGION" --query "BackupPlan.Rules[?RuleName=='Daily'].CompletionWindowMinutes" --output text)"
[ "$GOT" = "120" ] || fail "CompletionWindow not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

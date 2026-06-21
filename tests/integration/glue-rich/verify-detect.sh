#!/usr/bin/env bash
# Glue Job detect + revert (real AWS). The revert is the point: Glue::Job's Cloud
# Control UpdateResource REJECTS a property patch for a WorkerType job — AWS returns a
# computed MaxCapacity and re-submitting it with WorkerType fails "do not set Max
# Capacity if using Worker Type". Revert goes through the GetJob->UpdateJob SDK writer
# (which omits MaxCapacity when WorkerType is set). Drift the declared MUTABLE Timeout
# 10->20 out of band -> check MUST DETECT -> revert (SDK writer) -> CLEAN + restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueRich; JOB=cdkrd-integ-glue-rich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out job.json ju.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob Timeout 10->20 (update-job) ==="
aws glue get-job --job-name "$JOB" --region "$REGION" --query Job > job.json
node -e "const j=require('./job.json');const u={Role:j.Role,Command:j.Command,Timeout:20,GlueVersion:j.GlueVersion,WorkerType:j.WorkerType,NumberOfWorkers:j.NumberOfWorkers,MaxRetries:j.MaxRetries,Description:j.Description};require('fs').writeFileSync('ju.json',JSON.stringify(u));"
aws glue update-job --job-name "$JOB" --job-update file://ju.json --region "$REGION" >/dev/null || fail inject
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-glue-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Timeout" /tmp/cdkrd-glue-detect.out || fail "Timeout drift not reported"
echo "=== revert (SDK writer: UpdateJob, omits MaxCapacity) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-glue-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-glue-revert.out || fail "revert did not converge (CC MaxCapacity+WorkerType regression?)"
GOT="$(aws glue get-job --job-name "$JOB" --region "$REGION" --query 'Job.Timeout' --output text)"
[ "$GOT" = "10" ] || fail "Timeout not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

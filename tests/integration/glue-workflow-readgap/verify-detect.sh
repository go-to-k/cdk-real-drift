#!/usr/bin/env bash
# Glue Workflow detect + revert (the false-NEGATIVE half): deploy -> record -> change a
# DECLARED MUTABLE property (MaxConcurrentRuns) out of band -> check MUST DETECT (exit 1)
# -> revert (UpdateWorkflow SDK writer) -> check CLEAN -> live restored AND the other
# fields (Description/DefaultRunProperties) PRESERVED (the revert reads the full live model
# and writes it all back — UpdateWorkflow is a whole-object overwrite). Before the
# SDK_OVERRIDES reader this was a silent FN (the workflow was CC-skipped).
#
# NOTE: the out-of-band edit passes ALL fields to update-workflow on purpose — Glue
# UpdateWorkflow is a full overwrite, so omitting Description/DefaultRunProperties would
# itself wipe them (an artifact of the CLI call, not of cdkrd).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueWorkflowReadgap; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
NAME=cdkrd-workflow
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== out-of-band: MaxConcurrentRuns 3 -> 7 (preserving the other fields) ==="
aws glue update-workflow --region "$REGION" --name "$NAME" \
  --description "cdkrd glue-workflow read-gap probe" \
  --default-run-properties '{"env":"test","team":"data"}' --max-concurrent-runs 7 >/dev/null || fail "inject"
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/gw-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "MaxConcurrentRuns" /tmp/gw-detect.out || fail "MaxConcurrentRuns not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
echo "=== check CLEAN after revert ==="; $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
RUNS="$(aws glue get-workflow --name "$NAME" --region "$REGION" --query "Workflow.MaxConcurrentRuns" --output text)"
DESC="$(aws glue get-workflow --name "$NAME" --region "$REGION" --query "Workflow.Description" --output text)"
PROPS="$(aws glue get-workflow --name "$NAME" --region "$REGION" --query "Workflow.DefaultRunProperties.env" --output text)"
[ "$RUNS" = "3" ] || fail "MaxConcurrentRuns not restored (got $RUNS)"
[ "$DESC" = "cdkrd glue-workflow read-gap probe" ] || fail "Description wiped by revert (got: $DESC)"
[ "$PROPS" = "test" ] || fail "DefaultRunProperties wiped by revert (got: $PROPS)"
echo "INTEG PASS ($STACK detect+revert)"

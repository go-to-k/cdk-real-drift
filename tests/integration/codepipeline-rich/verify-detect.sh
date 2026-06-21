#!/usr/bin/env bash
# Detection + revert integration test (real AWS) for the CodePipeline sorted-array
# index-misalignment fix. CodePipeline Stages/Actions carry a per-element Name, so the
# generic identity-keyed sort USED to reorder them (Build < Source) — but the array
# order is semantically significant AND the Cloud Control revert patch addresses the
# RAW (unsorted) live model by index. Drifting a DECLARED, MUTABLE property in the
# SOURCE stage (raw index 0, but sorted to index 1) proves the finding index now aligns
# with the raw model: detect -> revert -> re-check CLEAN -> live value restored.
# Without the fix the revert patch lands on the WRONG stage (Build) and the drift
# silently survives ("1 drift remains").
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCodepipelineRich
REGION="${AWS_REGION:-us-east-1}"
PIPELINE=cdkrd-pipeline-rich
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (snapshot undeclared) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] baseline check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN before drift"

echo "=== [$STACK] out-of-band drift: Source action S3ObjectKey source.zip -> drifted.zip ==="
# get-pipeline -> mutate the Source stage's S3 action Configuration.S3ObjectKey -> update-pipeline
aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" --query pipeline > /tmp/cp-pipeline.json || fail "get-pipeline"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("/tmp/cp-pipeline.json", "utf8"));
  const src = p.stages.find((s) => s.name === "Source");
  const act = src.actions.find((a) => a.name === "S3Source");
  if (act.configuration.S3ObjectKey !== "source.zip") throw new Error("unexpected pre-drift value: " + act.configuration.S3ObjectKey);
  act.configuration.S3ObjectKey = "drifted.zip";
  fs.writeFileSync("/tmp/cp-pipeline-drifted.json", JSON.stringify({ pipeline: p }));
' || fail "mutate pipeline json"
aws codepipeline update-pipeline --cli-input-json file:///tmp/cp-pipeline-drifted.json --region "$REGION" >/dev/null || fail "update-pipeline"

echo "=== [$STACK] check MUST DETECT the drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detected (exit 1), got $rc"
grep -q "S3ObjectKey" "/tmp/cdkrd-$STACK-detect.out" || fail "drift output did not mention S3ObjectKey"

echo "=== [$STACK] revert MUST restore the value ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== [$STACK] re-check MUST be CLEAN (revert hit the right stage) ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert — index misalignment would leave drift here"

echo "=== [$STACK] confirm live value restored to source.zip ==="
live=$(aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" \
  --query "pipeline.stages[?name=='Source'].actions[0].configuration.S3ObjectKey | [0]" --output text)
[ "$live" = "source.zip" ] || fail "live S3ObjectKey is '$live', expected 'source.zip'"

echo "INTEG PASS ($STACK)"

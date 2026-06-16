#!/usr/bin/env bash
# cdk-real-drift CDK-Stages stack-DISCOVERY integration test.
#
# A stack nested inside a CDK `Stage` (the CDK Pipelines / multi-env pattern) is
# absent from `cloudAssembly.stacks` (top-level assembly only) — `synthApp` must use
# `stacksRecursively` to descend into nested assemblies, else the staged stack is
# silently never discovered, never checked. This asserts BOTH the top-level stack and
# the staged stack are enumerated.
#
# DISCOVERY-ONLY: it synthesizes locally and runs `check` (the stacks are NOT
# deployed, so each reports "not deployed yet — skipped"); we only assert that both
# stack NAMES appear in the output. Needs AWS creds for the DescribeStacks probe, but
# deploys/destroys NOTHING.
# Usage:  cd tests/integration/stages && npm install && bash verify-stages.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() { rm -rf cdk.out .cdkrd; }
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== check (synthesize + discover; nothing deployed) ==="
OUT=/tmp/cdk-real-drift-integ-stages.out
AWS_REGION="$REGION" $CLI check --app "node --experimental-strip-types app.ts" 2>&1 | tee "$OUT"

grep -q "TopStack" "$OUT" || fail "top-level TopStack not discovered"
grep -q "ProdStage-ApiStack" "$OUT" || fail "staged ProdStage-ApiStack not discovered (stacksRecursively regression?)"

echo "INTEG PASS"

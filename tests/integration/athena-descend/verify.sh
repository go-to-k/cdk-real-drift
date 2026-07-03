#!/usr/bin/env bash
# Integration test #565 (real AWS): an out-of-band non-default sub-key on an undeclared
# WorkGroupConfiguration DESCENDS to a single nested finding instead of surfacing the whole
# object; the constant defaults still fold.
#   deploy -> record baseline -> check CLEAN (whole default folds atDefault)
#   -> inject one non-default sub-key -> check DETECTS only the descended sub-key -> destroy.
# Run with CDKRD_CORPUS_DIR=<dir> to record the golden-corpus case for the descend.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkRealDriftIntegAthenaDescend
WG=cdkrd-integ-athena-descend
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
# Harvest only at the descend point (not on the clean check); unset so the CLEAN check doesn't record.
CORPUS_DIR="${CDKRD_CORPUS_DIR:-}"; unset CDKRD_CORPUS_DIR

cleanup() {
  echo "--- cleanup ---"
  aws athena delete-work-group --work-group "$WG" --recursive-delete-option --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

echo "=== record baseline ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check CLEAN (whole default WorkGroupConfiguration folds atDefault) ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after record"

echo "=== inject ONE non-default sub-key out of band (BytesScannedCutoffPerQuery) ==="
aws athena update-work-group --work-group "$WG" --region "$REGION" \
  --configuration-updates 'BytesScannedCutoffPerQuery=10000000' || fail "update-work-group"
sleep 5

echo "=== check DETECTS the descended sub-key ONLY ==="
$CLI check "$STACK" --region "$REGION" --json > /tmp/cdkrd-athena-descend.json || true
$CLI check "$STACK" --region "$REGION" --show-all || true

if [ -n "$CORPUS_DIR" ]; then
  echo "=== harvest corpus (descended WorkGroupConfiguration) ==="
  CDKRD_CORPUS_DIR="$CORPUS_DIR" $CLI check "$STACK" --region "$REGION" >/dev/null || true
fi

node -e '
const j=require("/tmp/cdkrd-athena-descend.json");
const wg=(j.findings||[]).filter(f=>f.resourceType==="AWS::Athena::WorkGroup");
const drift=wg.filter(f=>f.tier==="undeclared"||f.tier==="declared").map(f=>f.path);
console.error("WorkGroup findings:",JSON.stringify(wg.map(f=>({tier:f.tier,path:f.path}))));
if(!wg.some(f=>f.path==="WorkGroupConfiguration.BytesScannedCutoffPerQuery"&&(f.tier==="undeclared"||f.tier==="declared")))
  { console.error("FAIL: descended sub-key not found as drift"); process.exit(1); }
if(drift.includes("WorkGroupConfiguration"))
  { console.error("FAIL: whole WorkGroupConfiguration surfaced (not descended)"); process.exit(1); }
console.error("OK: only the descended BytesScannedCutoffPerQuery sub-key surfaced as drift");
' || fail "descend assertion (see /tmp/cdkrd-athena-descend.json)"

echo "INTEG PASS: athena-descend (#565)"

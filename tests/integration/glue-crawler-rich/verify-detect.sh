#!/usr/bin/env bash
# Glue Crawler detect + revert integration test (real AWS): the "someone changed
# the crawler config in the console" scenario. Deploy -> record -> change a
# DECLARED MUTABLE scalar (TablePrefix) out of band via update-crawler (a partial
# in-place update) -> check MUST DETECT (exit 1) -> revert -> check MUST be CLEAN
# and the live value restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegGlueCrawlerRich
CRAWLER=cdkrd-crawler-rich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: TablePrefix cdkrd_ -> edited_ (console-edit) ==="
aws glue update-crawler --name "$CRAWLER" --table-prefix "edited_" \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-glue-crawler-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "TablePrefix" /tmp/cdkrd-glue-crawler-detect.out || fail "TablePrefix not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live TablePrefix MUST be restored to cdkrd_ ==="
GOT="$(aws glue get-crawler --name "$CRAWLER" --region "$REGION" \
  --query "Crawler.TablePrefix" --output text)"
[ "$GOT" = "cdkrd_" ] || fail "live TablePrefix not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"

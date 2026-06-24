#!/usr/bin/env bash
# Glue Table detect->revert->clean (real AWS, mutating). Proves the new writeGlueTable
# (GetTable -> UpdateTable) reverts an out-of-band TableInput.Description edit.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueTableRevert; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
DB=cdkrd_revert_db; TBL=cdkrd_revert_table
cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record + check CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"
echo "=== mutate TableInput.Description out of band ==="
aws glue update-table --database-name "$DB" --region "$REGION" --table-input \
  '{"Name":"'"$TBL"'","Description":"CHANGED out of band","TableType":"EXTERNAL_TABLE","Parameters":{"classification":"json"},"StorageDescriptor":{"Location":"s3://cdkrd-revert-placeholder/data/","Columns":[{"Name":"id","Type":"string"}]}}' \
  || fail "out-of-band update-table"
sleep 3
echo "=== check DETECTS (exit 1, Description) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/gt-pre.out; [ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "Description" /tmp/gt-pre.out || fail "Description drift not reported"
echo "=== revert --yes ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/gt-rev.out || fail "revert non-zero"
sleep 3
echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert (revert no-op bug)"
echo "=== confirm live Description restored ==="
GOT="$(aws glue get-table --database-name "$DB" --name "$TBL" --region "$REGION" --query 'Table.Description' --output text)"
[ "$GOT" = "declared table description" ] || fail "live Description not restored (got: $GOT)"
echo "INTEG PASS ($STACK)"

#!/usr/bin/env bash
# Glue Classifier detect + revert (the false-NEGATIVE half): deploy -> record -> change a
# DECLARED MUTABLE property (CSV Delimiter) out of band via update-classifier -> check MUST
# DETECT (exit 1) -> revert (UpdateClassifier SDK writer) -> check CLEAN -> live restored.
# Before the SDK_OVERRIDES reader this was a silent FN (the classifier was CC-skipped).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueClassifierReadgap; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
NAME=cdkrd-csv-classifier
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
ORIG="$(aws glue get-classifier --name "$NAME" --region "$REGION" --query 'Classifier.CsvClassifier.Delimiter' --output text)"
[ "$ORIG" = "," ] || fail "unexpected original delimiter: $ORIG"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== out-of-band: delimiter , -> | ==="
aws glue update-classifier --region "$REGION" --csv-classifier \
  '{"Name":"cdkrd-csv-classifier","Delimiter":"|","QuoteSymbol":"\"","ContainsHeader":"PRESENT","Header":["id","name","value"]}' >/dev/null || fail "inject"
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/gc-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Delimiter" /tmp/gc-detect.out || fail "Delimiter not reported"
echo "=== revert ==="; $CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
echo "=== check CLEAN after revert ==="; $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
GOT="$(aws glue get-classifier --name "$NAME" --region "$REGION" --query 'Classifier.CsvClassifier.Delimiter' --output text)"
[ "$GOT" = "$ORIG" ] || fail "live delimiter not restored (got [$GOT] want [$ORIG])"
echo "INTEG PASS ($STACK detect+revert)"

#!/usr/bin/env bash
# Prepare the cdk-real-drift demo for recording (see demo/README.md):
#   1. deploy the demo stack (one IAM role, no declared inline policies);
#   2. record a clean baseline (so the next check would be CLEAN);
#   3. inject an OUT-OF-BAND undeclared change — an inline policy the template
#      never declared (the kind `cdk drift` can't see).
# After this, `vhs demo/cdkrd.tape` records the check -> revert sequence.
#
# Requires: AWS credentials + a bootstrapped account (CDKToolkit), and the cdkrd
# CLI built (run `vp run build` at the repo root, or `npm i -g cdk-real-drift`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$HERE"
REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="cdkrd-demo-api-role"

echo "=== 1/3 deploy demo stack ==="
[ -d node_modules ] || npm install
npx cdk deploy -f CdkrdDemo --require-approval never

echo "=== 2/3 record a clean baseline ==="
node "$ROOT/dist/cli.js" record CdkrdDemo --region "$REGION" --yes

echo "=== 3/3 inject an out-of-band undeclared inline policy ==="
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name manual-debug-access \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}' \
  --region "$REGION"

echo
echo "Ready to record. Now run:  vhs demo/cdkrd.tape   (produces demo/demo.gif)"
echo "When done:                 bash demo/teardown.sh"

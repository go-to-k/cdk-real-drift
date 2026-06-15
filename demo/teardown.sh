#!/usr/bin/env bash
# Tear down the cdk-real-drift demo: drop the injected inline policy and destroy
# the stack. Safe to run repeatedly.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="cdkrd-demo-api-role"

aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name manual-debug-access \
  --region "$REGION" >/dev/null 2>&1 || true
npx cdk destroy -f CdkrdDemo >/dev/null 2>&1 || true
rm -rf .cdkrd cdk.out
echo "demo torn down."

#!/usr/bin/env bash
# Glue Connection detect (the false-NEGATIVE half): deploy -> record -> change a DECLARED
# MUTABLE property (Description) out of band via update-connection -> check MUST DETECT
# (exit 1). Before the SDK_OVERRIDES reader this was a silent FN (the connection was
# CC-skipped). NOTE: the reader is READ-ONLY (no SDK writer) — closing the FN is the value;
# a revert that omitted an un-read credential could clear a JDBC password, so it is
# deferred. So this script asserts detection only and restores the value by hand.
#
# Two AWS-CLI gotchas: `AWS_CLI_AUTO_PROMPT=off` (the partial-prompt feature errors with
# Errno 22 in a non-tty), and UpdateConnection REQUIRES ConnectionProperties (even {}).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegGlueConnectionReadgap; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
NAME=cdkrd-network-conn
export CDK_DEFAULT_REGION="$REGION"
CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"; export CDK_DEFAULT_ACCOUNT
export AWS_PAGER="" AWS_CLI_AUTO_PROMPT=off
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
SUBNET="$(aws glue get-connection --name "$NAME" --region "$REGION" --query 'Connection.PhysicalConnectionRequirements.SubnetId' --output text)"
SG="$(aws glue get-connection --name "$NAME" --region "$REGION" --query 'Connection.PhysicalConnectionRequirements.SecurityGroupIdList[0]' --output text)"
AZ="$(aws glue get-connection --name "$NAME" --region "$REGION" --query 'Connection.PhysicalConnectionRequirements.AvailabilityZone' --output text)"
ORIG="cdkrd glue connection read-gap probe"
mkci(){ printf '{"Name":"%s","ConnectionType":"NETWORK","Description":"%s","ConnectionProperties":{},"PhysicalConnectionRequirements":{"SubnetId":"%s","SecurityGroupIdList":["%s"],"AvailabilityZone":"%s"}}' "$NAME" "$1" "$SUBNET" "$SG" "$AZ"; }
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail "record"
echo "=== out-of-band: Description change ==="
aws glue update-connection --region "$REGION" --name "$NAME" --connection-input "$(mkci 'CHANGED out of band')" </dev/null || fail "inject"
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/gconn-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Description" /tmp/gconn-detect.out || fail "Description drift not reported"
echo "=== restore (read-only override — no cdkrd revert) ==="
aws glue update-connection --region "$REGION" --name "$NAME" --connection-input "$(mkci "$ORIG")" </dev/null || fail "restore"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after manual restore"
echo "INTEG PASS ($STACK detect; read-only override, revert deferred)"

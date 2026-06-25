#!/usr/bin/env bash
# cdk-real-drift `added` integ test for EFS (the SIXTEENTH CHILD_ENUMERATORS member).
#   deploy fixture (VPC + 2 public subnets + EFS file system + SG + 1 declared mount
#     target in subnet[0]) -> record -> CLEAN (the declared mount target is NOT flagged)
#   -> create-mount-target an undeclared mount target in subnet[1] out of band -> check
#      reports it under [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots it
#      (proves CC GetResource + normalize for AWS::EFS::MountTarget) -> CLEAN
#   -> for revert: delete the recorded one, recreate a fresh out-of-band mount target in
#      subnet[1] -> `revert --remove-unrecorded` DELETES it via Cloud Control
#      DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap removes the
# out-of-band mount targets off the file system FIRST (else they block the file system's
# deletion -> the stack goes DELETE_FAILED) and then destroys the stack even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/efs-mounttarget-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEfsMountTargetAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

resolve_fs() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::EFS::FileSystem'].PhysicalResourceId" \
    --output text 2>/dev/null
}

# Wait for a mount target to leave the deleting/creating states and disappear (deleted).
wait_mt_gone() { # $1 = mount target id
  for _ in $(seq 1 30); do
    if ! aws efs describe-mount-targets --mount-target-id "$1" --region "$REGION" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
}

# Poll a mount target until it reaches the `available` state.
wait_mt_available() { # $1 = mount target id
  for _ in $(seq 1 30); do
    local state
    state="$(aws efs describe-mount-targets --mount-target-id "$1" --region "$REGION" \
      --query 'MountTargets[0].LifeCycleState' --output text 2>/dev/null)"
    [ "$state" = "available" ] && return 0
    sleep 5
  done
  fail "mount target $1 never became available"
}

cleanup() {
  echo "--- cleanup ---"
  # An out-of-band mount target we recorded (but did not revert) lingers and BLOCKS the
  # file system's deletion (CFn cannot delete a file system that still has mount targets)
  # -> the stack goes DELETE_FAILED, and delstack only sees STACK members, not a
  # stack-external mount target sitting on a member file system. So delete every mount
  # target whose SubnetId != the declared subnet (subnet[0]) FIRST and wait for them to
  # clear.
  local fs
  fs="$(resolve_fs)"
  if [ -n "$fs" ] && [ "$fs" != "None" ]; then
    local declared_subnet="${SUBNET0:-}"
    local removed=""
    for row in $(aws efs describe-mount-targets --file-system-id "$fs" --region "$REGION" \
      --query 'MountTargets[].[MountTargetId,SubnetId]' --output text 2>/dev/null | tr '\t' ',' ); do
      local mt="${row%%,*}"
      local sn="${row##*,}"
      if [ -n "$declared_subnet" ] && [ "$sn" = "$declared_subnet" ]; then
        continue # keep the declared one — delstack/CFn deletes it with the stack
      fi
      aws efs delete-mount-target --mount-target-id "$mt" --region "$REGION" >/dev/null 2>&1 || true
      removed="$removed $mt"
    done
    for mt in $removed; do wait_mt_gone "$mt"; done
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out

  echo "--- verify no orphans ---"
  if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
    echo "WARN: stack $STACK still exists after teardown"
  else
    echo "OK: stack gone"
  fi
  local vpcleft
  vpcleft="$(aws ec2 describe-vpcs --region "$REGION" \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null)"
  [ -z "$vpcleft" ] || echo "WARN: VPC(s) still present: $vpcleft"
  [ -z "$vpcleft" ] && echo "OK: VPC gone"
  local efsleft
  efsleft="$(aws efs describe-file-systems --region "$REGION" \
    --query "FileSystems[?Tags[?Key=='aws:cloudformation:stack-name' && Value=='$STACK']].FileSystemId" \
    --output text 2>/dev/null)"
  [ -z "$efsleft" ] || echo "WARN: EFS file system(s) still present: $efsleft"
  [ -z "$efsleft" ] && echo "OK: no orphan EFS"
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_mt() { # creates an out-of-band mount target in subnet[1], echoes the MountTargetId
  aws efs create-mount-target --file-system-id "$FS" --subnet-id "$SUBNET1" \
    --security-groups "$SG" --region "$REGION" \
    --query MountTargetId --output text || fail "create-mount-target"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== resolve stack resources ==="
FS="$(resolve_fs)"
[ -n "$FS" ] && [ "$FS" != "None" ] || fail "could not resolve EFS FileSystem id"
SG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" \
  --output text 2>/dev/null)"
[ -n "$SG" ] && [ "$SG" != "None" ] || fail "could not resolve SecurityGroup id"
# The declared mount target sits in subnet[0]; inject the out-of-band one into subnet[1].
read -r SUBNET0 SUBNET1 <<<"$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" \
  --query 'sort_by(Subnets,&AvailabilityZone)[].SubnetId' --output text 2>/dev/null)"
[ -n "$SUBNET0" ] && [ -n "$SUBNET1" ] || fail "need 2 subnets, got: '$SUBNET0' '$SUBNET1'"
echo "FS=$FS SG=$SG SUBNET0=$SUBNET0 SUBNET1=$SUBNET1"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared mount target not flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== create an undeclared mount target in subnet[1] out of band ==="
MT1="$(inject_mt)"
[ -n "$MT1" ] || fail "no MountTargetId for the first injected mount target"
wait_mt_available "$MT1"

echo "=== check reports it as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-efs.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-efs.out || fail "added mount target not under [Potential Drift]"
grep -q "AWS::EFS::MountTarget" /tmp/cdkrd-integ-efs.out || fail "the out-of-band mount target not reported"
grep -q "added=" /tmp/cdkrd-integ-efs.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added mount target (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for EFS::MountTarget) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-efs-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added mount target, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-efs-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== delete the recorded one + recreate a fresh out-of-band mount target for revert ==="
# EFS allows one mount target per subnet/AZ, so free subnet[1] before recreating.
aws efs delete-mount-target --mount-target-id "$MT1" --region "$REGION" >/dev/null 2>&1 || true
wait_mt_gone "$MT1"
MT2="$(inject_mt)"
[ -n "$MT2" ] || fail "no MountTargetId for the second injected mount target"
wait_mt_available "$MT2"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-efs-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-efs-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-efs-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-efs-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second mount target must be gone from AWS ==="
wait_mt_gone "$MT2"
if aws efs describe-mount-targets --mount-target-id "$MT2" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted mount target still exists (delete did not take effect)"
fi

echo "INTEG PASS"

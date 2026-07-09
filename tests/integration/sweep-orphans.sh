#!/usr/bin/env bash
# cdk-real-drift integ orphan sweep — a SAFETY NET for stack-external orphans.
#
# Every fixture's verify.sh tears its own stack down (delstack cdk), but stack
# teardown only deletes stack MEMBERS. Resources that outlive the stack —
# RETAIN-policy stateful resources (Kinesis/RDS/DynamoDB/EFS), auto-created
# Lambda/APIGW log groups, Secrets in their recovery window, KMS keys pending
# deletion — linger and bill silently. This script finds and (optionally)
# deletes those, scoped STRICTLY to cdk-real-drift's own integ name tokens.
#
# Scope: matches only resources whose name contains a cdkrd integ token
#   (Cdkrd | Cdkdrift | CdkRealDrift, case-insensitive). It deliberately does
#   NOT match the cdkd project (`cdkd-*`): the regex requires the full token, so
#   `Cdkdrift` matches but a bare `cdkd-` / `CdkdRemove*` does not. Resources
#   that are still members of an ACTIVE CloudFormation stack are never touched.
#
# Usage:
#   bash sweep-orphans.sh              # DRY RUN — list candidates, delete nothing
#   bash sweep-orphans.sh --delete     # actually delete the listed orphans
#   AWS_REGION=us-west-2 bash sweep-orphans.sh --delete
#
# Exit code: 0 always in dry-run; 0 if nothing deleted / all deletes succeeded,
# 1 if any delete failed. Prints "SWEEP CLEAN" when no orphans are found.
set -uo pipefail
REGION="${AWS_REGION:-us-east-1}"
DELETE=0
[ "${1:-}" = "--delete" ] || [ "${1:-}" = "-y" ] && DELETE=1

# cdkrd integ name tokens. Word-token match (not bare "cdkd") so the cdkd
# project is never in scope. grep -E, case-insensitive.
TOKEN='cdkrd|cdkdrift|cdkrealdrift'

found=0
failed=0

note() { printf '%s\n' "$*"; }
hit()  { found=$((found + 1)); }

# is the given physical name a member of an ACTIVE stack? (protect live resources)
# List every not-yet-deleted stack name in a region (any status a live/pending
# resource could belong to). Prints one name per line.
list_active_stacks() {
  # Include DELETE_IN_PROGRESS: a stack mid-teardown is still deleting its own
  # members, so those are NOT orphans yet — let CloudFormation finish rather than
  # racing it (and false-flagging a peer's in-flight teardown).
  aws cloudformation list-stacks --region "$1" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
      ROLLBACK_COMPLETE CREATE_IN_PROGRESS UPDATE_IN_PROGRESS REVIEW_IN_PROGRESS \
      UPDATE_ROLLBACK_IN_PROGRESS DELETE_FAILED DELETE_IN_PROGRESS \
    --query 'StackSummaries[].StackName' --output text 2>/dev/null | tr '\t' '\n'
}

ACTIVE_STACKS="$(list_active_stacks "$REGION")"

# GLOBAL resources (IAM roles/instance profiles) are not region-scoped, so a role
# left by a stack in ANOTHER region must NOT be swept while sweeping this one. Guard
# them against active stacks across ALL the project's regions, not just $REGION.
# Override the set with CDKRD_SWEEP_IAM_REGIONS="us-east-1 us-west-2 ...".
IAM_REGIONS="${CDKRD_SWEEP_IAM_REGIONS:-$REGION us-east-1 us-west-2 ap-northeast-1}"
read -ra _iam_regions <<<"$IAM_REGIONS"
ACTIVE_STACKS_GLOBAL="$(
  printf '%s\n' "${_iam_regions[@]}" | sort -u | while IFS= read -r r; do
    [ -n "$r" ] && list_active_stacks "$r"
  done
)"

# A cdkrd-token resource is an orphan unless its name embeds an active stack name.
# `stacks` selects the guard set: the region-local set for regional resources, the
# all-regions set for global (IAM) ones. Match is CASE-INSENSITIVE: AWS lowercases
# many physical names (RDS/DocDB identifiers, S3 buckets, ELB names) while stack
# names are mixed-case, so a case-sensitive compare would fail to see the backing
# stack and FALSE-flag a live resource as an orphan (→ delete a peer's active DB).
_name_backed_by() {
  local name stacks="$2" s
  name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for s in $stacks; do
    [ -n "$s" ] || continue
    s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
    case "$name" in *"$s"*) return 0 ;; esac
  done
  return 1
}
is_backed()        { _name_backed_by "$1" "$ACTIVE_STACKS"; }
is_backed_global() { _name_backed_by "$1" "$ACTIVE_STACKS_GLOBAL"; }

# delete <kind> <name> <delete-cmd...>
sweep_one() {
  local kind="$1" name="$2"; shift 2
  if is_backed "$name"; then
    note "  SKIP (active-stack member): $kind $name"
    return
  fi
  hit
  if [ "$DELETE" -eq 1 ]; then
    if "$@" >/dev/null 2>&1; then
      note "  DELETED: $kind $name"
    else
      note "  FAILED:  $kind $name"
      failed=$((failed + 1))
    fi
  else
    note "  ORPHAN (dry-run): $kind $name"
  fi
}

note "=== cdk-real-drift orphan sweep (region=$REGION, delete=$DELETE) ==="

note "--- Kinesis streams ---"
for s in $(aws kinesis list-streams --region "$REGION" --query 'StreamNames' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one Kinesis "$s" aws kinesis delete-stream --stream-name "$s" --enforce-consumer-deletion --region "$REGION"
done

note "--- DynamoDB tables ---"
for t in $(aws dynamodb list-tables --region "$REGION" --query 'TableNames' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one DynamoDB "$t" aws dynamodb delete-table --table-name "$t" --region "$REGION"
done

note "--- RDS instances ---"
for d in $(aws rds describe-db-instances --region "$REGION" --query 'DBInstances[].DBInstanceIdentifier' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one RDS-instance "$d" aws rds delete-db-instance --db-instance-identifier "$d" --skip-final-snapshot --delete-automated-backups --region "$REGION"
done

note "--- RDS clusters ---"
for c in $(aws rds describe-db-clusters --region "$REGION" --query 'DBClusters[].DBClusterIdentifier' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one RDS-cluster "$c" aws rds delete-db-cluster --db-cluster-identifier "$c" --skip-final-snapshot --region "$REGION"
done

note "--- EFS file systems ---"
while IFS=$'\t' read -r fsid name; do
  [ -n "$fsid" ] || continue
  printf '%s' "$name" | grep -Eqi "$TOKEN" || continue
  sweep_one EFS "$name($fsid)" aws efs delete-file-system --file-system-id "$fsid" --region "$REGION"
done < <(aws efs describe-file-systems --region "$REGION" --query 'FileSystems[].[FileSystemId,Name]' --output text 2>/dev/null)

note "--- Secrets (force, no recovery) ---"
for s in $(aws secretsmanager list-secrets --include-planned-deletion --region "$REGION" --query 'SecretList[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one Secret "$s" aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery --region "$REGION"
done

note "--- CloudWatch log groups ---"
for g in $(aws logs describe-log-groups --region "$REGION" --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  sweep_one LogGroup "$g" aws logs delete-log-group --log-group-name "$g" --region "$REGION"
done

# --- IAM roles (GLOBAL) --------------------------------------------------------
# CloudFormation-created roles (e.g. an API Gateway account CloudWatch role, a
# Lambda service role) can outlive their stack when the stack is force-deleted or
# the role was RETAINed — the class that leaked undetected before this sweep knew
# about IAM. IAM is global, so guard against active stacks across ALL project
# regions (is_backed_global), never just $REGION. Tear down fully (detach managed +
# delete inline + detach from instance profiles) before delete.
iam_role_teardown() {
  local r="$1" p ip
  for p in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "$r" --policy-arn "$p" >/dev/null 2>&1 || return 1
  done
  for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "$r" --policy-name "$p" >/dev/null 2>&1 || return 1
  done
  for ip in $(aws iam list-instance-profiles-for-role --role-name "$r" --query 'InstanceProfiles[].InstanceProfileName' --output text 2>/dev/null); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$ip" --role-name "$r" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "$r" >/dev/null 2>&1
}

note "--- IAM roles (global) ---"
for r in $(aws iam list-roles --query 'Roles[].RoleName' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  if is_backed_global "$r"; then
    note "  SKIP (active-stack member, any region): IAM-role $r"
    continue
  fi
  hit
  if [ "$DELETE" -eq 1 ]; then
    if iam_role_teardown "$r"; then note "  DELETED: IAM-role $r"; else note "  FAILED:  IAM-role $r"; failed=$((failed + 1)); fi
  else
    note "  ORPHAN (dry-run): IAM-role $r"
  fi
done

note "--- IAM instance profiles (global) ---"
for ipf in $(aws iam list-instance-profiles --query 'InstanceProfiles[].InstanceProfileName' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei "$TOKEN"); do
  if is_backed_global "$ipf"; then
    note "  SKIP (active-stack member, any region): InstanceProfile $ipf"
    continue
  fi
  hit
  if [ "$DELETE" -eq 1 ]; then
    for rr in $(aws iam get-instance-profile --instance-profile-name "$ipf" --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null); do
      aws iam remove-role-from-instance-profile --instance-profile-name "$ipf" --role-name "$rr" >/dev/null 2>&1 || true
    done
    if aws iam delete-instance-profile --instance-profile-name "$ipf" >/dev/null 2>&1; then
      note "  DELETED: InstanceProfile $ipf"
    else
      note "  FAILED:  InstanceProfile $ipf"; failed=$((failed + 1))
    fi
  else
    note "  ORPHAN (dry-run): InstanceProfile $ipf"
  fi
done

# --- Generic tag-based net (catches TYPES this script has no per-type rule for) --
# The per-type sweeps above are an allowlist — an ephemeral resource of a type not
# listed silently escaped (and `verify` falsely reported CLEAN). To close that, every
# ephemeral test deploy is tagged `cdkrd:ephemeral=1` (see the /sweep-resources and
# /work-issues + /hunt-bugs skills). Here we ask the Resource Groups Tagging API for
# ANY resource carrying that tag, regardless of type, and surface any not backed by an
# active stack. We do NOT auto-delete arbitrary types (risky + each needs its own
# API); we REPORT them so `found`>0 makes `verify` fail — an unknown-type orphan can
# never hide under a false SWEEP CLEAN again. Delete them with delstack / the console.
# (RGT API is regional and does not cover IAM — handled above — but does cover most
# taggable service resources.)
note "--- Tagged ephemeral resources (generic, any type) ---"
for arn in $(aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=cdkrd:ephemeral,Values=1 \
  --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | tr '\t' '\n'); do
  [ -n "$arn" ] || continue
  # ARN already deleted by a per-type sweep above may still be listed briefly; the
  # active-stack guard + a existence-agnostic report is fine (verify re-runs later).
  if is_backed "$arn" || is_backed_global "$arn"; then
    note "  SKIP (active-stack member): $arn"
    continue
  fi
  hit
  failed=$((failed + 1)) # unresolved by this script → keep verify RED until handled
  note "  ORPHAN (needs manual delete — delstack/console): $arn"
done

note "=== summary: $found orphan(s) found, $failed delete failure(s) ==="
if [ "$found" -eq 0 ]; then
  note "SWEEP CLEAN"
fi
[ "$failed" -eq 0 ] || exit 1

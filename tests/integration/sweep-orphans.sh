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
ACTIVE_STACKS="$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
    ROLLBACK_COMPLETE CREATE_IN_PROGRESS UPDATE_IN_PROGRESS REVIEW_IN_PROGRESS \
    UPDATE_ROLLBACK_IN_PROGRESS DELETE_FAILED \
  --query 'StackSummaries[].StackName' --output text 2>/dev/null)"

# A cdkrd-token resource is an orphan unless its name embeds an active stack name.
is_backed() {
  local name="$1" s
  for s in $ACTIVE_STACKS; do
    case "$name" in *"$s"*) return 0 ;; esac
  done
  return 1
}

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

note "=== summary: $found orphan(s) found, $failed delete failure(s) ==="
if [ "$found" -eq 0 ]; then
  note "SWEEP CLEAN"
fi
[ "$failed" -eq 0 ] || exit 1

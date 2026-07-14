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

# Layer 2 — the bughunt SENTINEL lists peers' IN-FLIGHT stacks (they explicitly declared
# "I'm deploying these"). Protect those too — covers a stack mid-CREATE and the strongest
# cross-agent coordination signal. Best-effort: resolve the shared main-tree root via git;
# degrade silently if unavailable. Skip the generic AUTODEPLOY token (not a stack name).
SENTINEL_STACKS=""
_gc="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$_gc" ]; then
  _root="$(dirname "$_gc")"
  SENTINEL_STACKS="$(cat "$_root"/.markgate-bughunt-pending.d/* "$_root/.markgate-bughunt-pending" 2>/dev/null \
    | grep -vE '^[[:space:]]*$' | grep -viF 'AUTODEPLOY' || true)"
fi

# Layer 1 — AUTHORITATIVE stack membership. Name-substring MISSES a live resource whose
# CFn physical name was truncated to 64 chars or hyphen-derived by a service (an active
# ImageBuilder role/pipeline was mis-flagged this way). Enumerate the actual members
# (PhysicalResourceId) of every active + sentinel-tracked stack across the IAM regions and
# protect anything whose id is a member — immune to name mangling AND to age. Best-effort
# (list-stack-resources per stack); empty result → the name + age guards still apply.
PROTECTED_STACKS="$(printf '%s\n%s\n' "$ACTIVE_STACKS_GLOBAL" "$SENTINEL_STACKS" | grep -vE '^[[:space:]]*$' | sort -u)"
MEMBER_IDS="$(
  printf '%s\n' "${_iam_regions[@]}" | sort -u | while IFS= read -r r; do
    [ -n "$r" ] || continue
    printf '%s\n' "$PROTECTED_STACKS" | while IFS= read -r s; do
      [ -n "$s" ] || continue
      aws cloudformation list-stack-resources --stack-name "$s" --region "$r" \
        --query 'StackResourceSummaries[].PhysicalResourceId' --output text 2>/dev/null | tr '\t' '\n'
    done
  done | grep -vE '^[[:space:]]*$' | sort -u
)"
# is_member <name> — the resource IS a member of a protected stack (exact physical-id match).
is_member() { [ -n "$MEMBER_IDS" ] && printf '%s\n' "$MEMBER_IDS" | grep -qFx "$1"; }

# stack_is_active <stack-name> — the name matches an active (any region) or sentinel-tracked
# stack, case-insensitively (whole line). Used by the generic tag net to honor a resource's own
# `aws:cloudformation:stack-name` tag: a resource CloudFormation still manages is never an orphan,
# even when the id-vs-ARN mismatch defeats is_member and name mangling defeats _name_backed_by.
stack_is_active() {
  [ -n "$1" ] || return 1
  printf '%s\n%s\n' "$ACTIVE_STACKS_GLOBAL" "$PROTECTED_STACKS" | grep -viE '^[[:space:]]*$' \
    | grep -qiFx "$1"
}

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
# Backed = an actual stack MEMBER (authoritative, layer 1) OR its name embeds an active
# stack name (cheap fallback). Membership is checked first — it is immune to name mangling.
is_backed()        { is_member "$1" || _name_backed_by "$1" "$ACTIVE_STACKS"; }
is_backed_global() { is_member "$1" || _name_backed_by "$1" "$ACTIVE_STACKS_GLOBAL"; }

# --- age guard: protect a peer's IN-FLIGHT resources from a name-match miss ---------
# is_backed's name-substring test MISSES a live resource when CloudFormation TRUNCATES
# the physical name to 64 chars (dropping the stack-name suffix) or a service derives a
# HYPHENATED name that no longer embeds the mixed-case stack name (ImageBuilder pipelines
# / roles / instance profiles). A dogfood run flagged 3 ACTIVE peer hunt resources as
# orphans exactly this way. An active peer's resources are RECENT, so ALSO refuse to
# sweep anything younger than CDKRD_SWEEP_MIN_AGE_HOURS (default 2) — a belt to
# is_backed's braces. Genuine orphans are hours/days/weeks old and still swept.
MIN_AGE_HOURS="${CDKRD_SWEEP_MIN_AGE_HOURS:-2}"
NOW_EPOCH="$(date -u +%s)"
# Portable timestamp -> epoch seconds: ISO-8601 (IAM CreateDate) or epoch millis
# (log-group creationTime). Unparseable/absent -> 0.
to_epoch() {
  local ts="$1" core e
  case "$ts" in ''|None|null) echo 0; return ;; esac
  printf '%s' "$ts" | grep -qE '^[0-9]{13}$' && { echo $(( ts / 1000 )); return; }
  printf '%s' "$ts" | grep -qE '^[0-9]{10}$' && { echo "$ts"; return; }
  e=$(date -u -d "$ts" +%s 2>/dev/null) && { echo "$e"; return; }   # GNU (Linux/CI)
  core="${ts%%.*}"; core="${core%%+*}"; core="${core%Z}"
  e=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$core" +%s 2>/dev/null) && { echo "$e"; return; }  # BSD (macOS)
  echo 0
}
# too_young <timestamp> -> true (protect) if younger than MIN_AGE_HOURS. FAIL-SAFE: an
# unparseable/absent timestamp is treated as YOUNG (protect) so a bad clock never deletes
# a live resource — a genuine orphan with no readable age is left for manual handling.
too_young() {
  local created; created="$(to_epoch "$1")"
  [ "$created" -eq 0 ] && return 0
  [ $(( NOW_EPOCH - created )) -lt $(( MIN_AGE_HOURS * 3600 )) ]
}

# resource_gone <arn> -> 0 (true) ONLY when the tagged resource PROVABLY no longer
# exists (a definitive not-found from a type-specific describe). The Resource Groups
# Tagging API index LAGS deletion: a resource deleted minutes/hours ago can still be
# returned under a tag filter (observed live 2026-07-10 — a Cognito user pool deleted
# by another session lingered in the index >45min AND could not be untagged
# [ResourceNotFoundException], blocking an unrelated agent's gate release). Skipping
# such a phantom is SAFE because the resource is already gone. Every other outcome
# (exists, ambiguous/permission error, unknown type) returns 1 so the ORPHAN stays RED
# — this never hides a REAL orphan (fail-safe, same posture as too_young()).
resource_gone() {
  local arn="$1" svc id err
  svc="$(printf '%s' "$arn" | cut -d: -f3)"
  case "$svc" in
    cognito-idp)
      # arn:aws:cognito-idp:<region>:<acct>:userpool/<poolId>
      id="${arn##*/}"
      [ -n "$id" ] || return 1
      err="$(aws cognito-idp describe-user-pool --user-pool-id "$id" --region "$REGION" 2>&1 >/dev/null)" && return 1
      printf '%s' "$err" | grep -q 'ResourceNotFoundException' && return 0
      return 1
      ;;
    ec2)
      # arn:aws:ec2:<region>:<acct>:vpc-endpoint/vpce-<id> — the second type observed
      # lingering in the RGT index after deletion (2026-07-10): DescribeVpcEndpoints
      # returned InvalidVpcEndpointId.NotFound while the tag filter still listed it,
      # keeping an unrelated agent's gate RED. Probed subtypes: vpc-endpoint, instance,
      # and volume; every other ec2 resource stays fail-safe (return 1 → ORPHAN stays RED).
      case "$arn" in
        *:vpc-endpoint/vpce-*)
          id="${arn##*/}"
          err="$(aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$id" --region "$REGION" 2>&1 >/dev/null)" && return 1
          printf '%s' "$err" | grep -q 'InvalidVpcEndpointId.NotFound' && return 0
          return 1
          ;;
        *:instance/i-*)
          # arn:aws:ec2:<region>:<acct>:instance/i-<id> — the third RGT-lag subtype
          # (2026-07-11): a terminated instance stays in the tag index after EC2 has
          # expunged it. DescribeInstances answers InvalidInstanceID.NotFound for an
          # unknown id, an EMPTY reservation list for an expunged one, or the instance
          # with State terminated while it ages out — nothing deletable remains in all
          # three shapes, so each counts as gone. Any OTHER state (running, stopped,
          # shutting-down, …) keeps the ORPHAN RED.
          id="${arn##*/}"
          local out state
          if ! out="$(aws ec2 describe-instances --instance-ids "$id" --region "$REGION" \
            --query 'Reservations[].Instances[].State.Name' --output text 2>&1)"; then
            printf '%s' "$out" | grep -q 'InvalidInstanceID.NotFound' && return 0
            return 1
          fi
          state="$(printf '%s' "$out" | tr -d '[:space:]')"
          { [ -z "$state" ] || [ "$state" = "terminated" ]; } && return 0
          return 1
          ;;
        *:vpc-endpoint-service/vpce-svc-*)
          # arn:aws:ec2:<region>:<acct>:vpc-endpoint-service/vpce-svc-<id> — the seventh
          # RGT-lag subtype (2026-07-14 hunt, attach-echo fixture): an endpoint service
          # deleted with its stack lingered in the tag index while
          # DescribeVpcEndpointServiceConfigurations answered
          # InvalidVpcEndpointServiceId.NotFound. Only NotFound counts as gone
          # (fail-safe, mirrors the vpc-endpoint arm).
          id="${arn##*/}"
          err="$(aws ec2 describe-vpc-endpoint-service-configurations --service-ids "$id" --region "$REGION" 2>&1 >/dev/null)" && return 1
          printf '%s' "$err" | grep -q 'InvalidVpcEndpointServiceId.NotFound' && return 0
          return 1
          ;;
        *:volume/vol-*)
          # arn:aws:ec2:<region>:<acct>:volume/vol-<id> — the fourth RGT-lag subtype
          # (2026-07-11, #1463): a just-deleted EBS volume lingers in the tag index for
          # minutes after DeleteVolume. DescribeVolumes answers InvalidVolume.NotFound once
          # it is gone. Only NotFound counts as gone — a volume that still exists in ANY
          # state (available / in-use / deleting) keeps the ORPHAN RED (fail-safe), mirroring
          # the vpc-endpoint arm.
          id="${arn##*/}"
          err="$(aws ec2 describe-volumes --volume-ids "$id" --region "$REGION" 2>&1 >/dev/null)" && return 1
          printf '%s' "$err" | grep -q 'InvalidVolume.NotFound' && return 0
          return 1
          ;;
        *:subnet/subnet-*)
          # arn:aws:ec2:<region>:<acct>:subnet/subnet-<id> — the fifth RGT-lag subtype
          # (2026-07-12 hunt): a subnet deleted with its stack lingered in the tag index
          # while DescribeSubnets answered InvalidSubnetID.NotFound. Only NotFound counts
          # as gone (fail-safe, mirrors the volume arm).
          id="${arn##*/}"
          err="$(aws ec2 describe-subnets --subnet-ids "$id" --region "$REGION" 2>&1 >/dev/null)" && return 1
          printf '%s' "$err" | grep -q 'InvalidSubnetID.NotFound' && return 0
          return 1
          ;;
        *:natgateway/nat-*)
          # arn:aws:ec2:<region>:<acct>:natgateway/nat-<id> — a deleted NAT gateway stays
          # visible in DescribeNatGateways with State "deleted" for ~an hour AND in the tag
          # index (2026-07-13 hunt, #1540 fixture). deleted/deleting counts as gone;
          # NotFound too. Any other state keeps the ORPHAN RED.
          id="${arn##*/}"
          local nst
          nst="$(aws ec2 describe-nat-gateways --nat-gateway-ids "$id" --region "$REGION" \
            --query 'NatGateways[0].State' --output text 2>/dev/null)" || return 0
          { [ "$nst" = "deleted" ] || [ "$nst" = "deleting" ] || [ "$nst" = "None" ]; } && return 0
          return 1
          ;;
        *:vpn-gateway/vgw-*)
          # Same terminal-state lag for the VPN family (2026-07-14 hunt cleanup, after a
          # peer's #1607 VPN fixture): a deleted VPN gateway / connection / customer
          # gateway stays visible in its describe with State "deleted" for a while AND in
          # the tag index, false-flagging as ORPHAN and blocking an unrelated gate.
          # deleted/deleting counts as gone; NotFound too. Any other state stays RED.
          id="${arn##*/}"
          local vgst
          vgst="$(aws ec2 describe-vpn-gateways --vpn-gateway-ids "$id" --region "$REGION" \
            --query 'VpnGateways[0].State' --output text 2>/dev/null)" || return 0
          { [ "$vgst" = "deleted" ] || [ "$vgst" = "deleting" ] || [ "$vgst" = "None" ]; } && return 0
          return 1
          ;;
        *:vpn-connection/vpn-*)
          # VPN connection twin of the vpn-gateway arm above (2026-07-14).
          id="${arn##*/}"
          local vcst
          vcst="$(aws ec2 describe-vpn-connections --vpn-connection-ids "$id" --region "$REGION" \
            --query 'VpnConnections[0].State' --output text 2>/dev/null)" || return 0
          { [ "$vcst" = "deleted" ] || [ "$vcst" = "deleting" ] || [ "$vcst" = "None" ]; } && return 0
          return 1
          ;;
        *:customer-gateway/cgw-*)
          # Customer gateway twin of the vpn-gateway arm above (2026-07-14).
          id="${arn##*/}"
          local cgst
          cgst="$(aws ec2 describe-customer-gateways --customer-gateway-ids "$id" --region "$REGION" \
            --query 'CustomerGateways[0].State' --output text 2>/dev/null)" || return 0
          { [ "$cgst" = "deleted" ] || [ "$cgst" = "deleting" ] || [ "$cgst" = "None" ]; } && return 0
          return 1
          ;;
        *:transit-gateway/tgw-*)
          # Same terminal-state lag for a deleted TRANSIT GATEWAY itself (2026-07-13
          # follow-up: a TGW orphaned by an attachment-race delstack, then deleted, stayed
          # visible as State "deleted" + in the tag index). The `-attachment` /
          # `-route-table` ARNs use the segments `transit-gateway-attachment/` /
          # `transit-gateway-route-table/`, which this `transit-gateway/` glob never
          # matches, so their arms below stay reachable.
          id="${arn##*/}"
          local tgst
          tgst="$(aws ec2 describe-transit-gateways --transit-gateway-ids "$id" --region "$REGION" \
            --query 'TransitGateways[0].State' --output text 2>/dev/null)" || return 0
          { [ "$tgst" = "deleted" ] || [ "$tgst" = "deleting" ] || [ "$tgst" = "None" ]; } && return 0
          return 1
          ;;
        *:transit-gateway-attachment/tgw-attach-*)
          # Same terminal-state lag for a deleted TGW attachment (2026-07-13 hunt).
          id="${arn##*/}"
          local tast
          tast="$(aws ec2 describe-transit-gateway-attachments --transit-gateway-attachment-ids "$id" \
            --region "$REGION" --query 'TransitGatewayAttachments[0].State' --output text 2>/dev/null)" || return 0
          { [ "$tast" = "deleted" ] || [ "$tast" = "deleting" ] || [ "$tast" = "None" ]; } && return 0
          return 1
          ;;
        *:transit-gateway-route-table/tgw-rtb-*)
          # Same terminal-state lag for a deleted TGW route table (2026-07-13 hunt).
          id="${arn##*/}"
          local trst
          trst="$(aws ec2 describe-transit-gateway-route-tables --transit-gateway-route-table-ids "$id" \
            --region "$REGION" --query 'TransitGatewayRouteTables[0].State' --output text 2>/dev/null)" || return 0
          { [ "$trst" = "deleted" ] || [ "$trst" = "deleting" ] || [ "$trst" = "None" ]; } && return 0
          return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    ecs)
      # ECS keeps deregistered/deleted resources visible as INACTIVE (by design), and the
      # RGT index returns them under the tag filter long after the stack is gone
      # (observed 2026-07-12: task-definition revisions CFn deregistered, a deleted
      # service, both INACTIVE). Nothing deletable remains in the INACTIVE state, so it
      # counts as gone; a MissingException/NotFound answer counts too. Any ACTIVE/
      # DRAINING answer (or an ambiguous error) keeps the ORPHAN RED (fail-safe).
      case "$arn" in
        *:task-definition/*)
          local st
          st="$(aws ecs describe-task-definition --task-definition "${arn##*task-definition/}" \
            --region "$REGION" --query 'taskDefinition.status' --output text 2>/dev/null)" || return 0
          [ "$st" = "INACTIVE" ] && return 0
          return 1
          ;;
        *:service/*)
          # arn:aws:ecs:<region>:<acct>:service/<cluster>/<service>
          local rest cluster service out
          rest="${arn##*:service/}"; cluster="${rest%%/*}"; service="${rest#*/}"
          [ -n "$cluster" ] && [ -n "$service" ] || return 1
          out="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
            --region "$REGION" --query 'services[0].status' --output text 2>/dev/null)" || return 0
          { [ "$out" = "INACTIVE" ] || [ "$out" = "None" ]; } && return 0
          return 1
          ;;
        *:cluster/*)
          local cst
          cst="$(aws ecs describe-clusters --clusters "${arn##*/}" --region "$REGION" \
            --query 'clusters[0].status' --output text 2>/dev/null)" || return 0
          { [ "$cst" = "INACTIVE" ] || [ "$cst" = "None" ]; } && return 0
          return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    kms)
      # arn:aws:kms:<region>:<acct>:key/<id> — a key already SCHEDULED FOR DELETION
      # (PendingDeletion / PendingReplicaDeletion) is self-resolving debris: nothing
      # deletable remains (deletion is scheduled; cancelling would be a restore, not a
      # sweep), yet it stays in the tag index for the whole 7-30-day window, which
      # deadlocked the bughunt-clean gate (2026-07-12 hunt: two rollback-orphaned CMKs).
      # An Enabled/Disabled key stays RED — a real orphan that needs schedule-key-deletion.
      case "$arn" in
        *:key/*)
          local kst
          kst="$(aws kms describe-key --key-id "${arn##*/}" --region "$REGION" \
            --query 'KeyMetadata.KeyState' --output text 2>/dev/null)" || {
              # NotFoundException = fully gone
              return 0
            }
          { [ "$kst" = "PendingDeletion" ] || [ "$kst" = "PendingReplicaDeletion" ]; } && return 0
          return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    batch)
      # arn:aws:batch:<region>:<acct>:job-definition/<name>:<rev> — the seventh
      # RGT-lag/terminal-state subtype (2026-07-13 hunt): CFn DEREGISTERS a job
      # definition at stack delete, Batch keeps it visible as INACTIVE (~180 days,
      # no delete API — deregister IS terminal), and the tag index kept flagging it
      # as an ORPHAN that nothing can delete. INACTIVE (or a not-found answer)
      # counts as gone; an ACTIVE answer keeps the ORPHAN RED (a real leftover
      # that needs deregistering).
      case "$arn" in
        *:job-definition/*)
          local bst
          bst="$(aws batch describe-job-definitions --job-definitions "$arn" \
            --region "$REGION" --query 'jobDefinitions[0].status' --output text 2>/dev/null)" || return 0
          { [ "$bst" = "INACTIVE" ] || [ "$bst" = "None" ]; } && return 0
          return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    rds)
      # arn:aws:rds:<region>:<acct>:snapshot:rds:<instance>-<ts> — the sixth RGT-lag
      # subtype (2026-07-13 hunt): a SYSTEM (automated) snapshot is removed together
      # with its deleted instance, yet its tagged mapping lingered in the index and
      # kept the gate RED. DescribeDBSnapshots answers DBSnapshotNotFound once gone;
      # an EXISTING snapshot (manual or automated-retained) stays RED — a real orphan
      # that needs an explicit delete.
      case "$arn" in
        *:snapshot:*)
          id="${arn#*:snapshot:}"
          [ -n "$id" ] || return 1
          err="$(aws rds describe-db-snapshots --db-snapshot-identifier "$id" \
            --region "$REGION" --query 'DBSnapshots[0].Status' --output text 2>&1)" || {
              printf '%s' "$err" | grep -q 'DBSnapshotNotFound' && return 0
              return 1
            }
          [ "$err" = "None" ] && return 0
          return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1 ;;
  esac
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
while IFS=$'\t' read -r g created; do
  [ -n "$g" ] || continue
  printf '%s' "$g" | grep -Eqi "$TOKEN" || continue
  if too_young "$created"; then
    note "  SKIP (younger than ${MIN_AGE_HOURS}h — likely an in-flight deploy): LogGroup $g"
    continue
  fi
  sweep_one LogGroup "$g" aws logs delete-log-group --log-group-name "$g" --region "$REGION"
done < <(aws logs describe-log-groups --region "$REGION" --query 'logGroups[].[logGroupName,creationTime]' --output text 2>/dev/null)

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
while IFS=$'\t' read -r r created; do
  [ -n "$r" ] || continue
  printf '%s' "$r" | grep -Eqi "$TOKEN" || continue
  if is_backed_global "$r"; then
    note "  SKIP (active-stack member, any region): IAM-role $r"
    continue
  fi
  if too_young "$created"; then
    note "  SKIP (younger than ${MIN_AGE_HOURS}h — likely an in-flight deploy): IAM-role $r"
    continue
  fi
  hit
  if [ "$DELETE" -eq 1 ]; then
    if iam_role_teardown "$r"; then note "  DELETED: IAM-role $r"; else note "  FAILED:  IAM-role $r"; failed=$((failed + 1)); fi
  else
    note "  ORPHAN (dry-run): IAM-role $r"
  fi
done < <(aws iam list-roles --query 'Roles[].[RoleName,CreateDate]' --output text 2>/dev/null)

note "--- IAM instance profiles (global) ---"
while IFS=$'\t' read -r ipf created; do
  [ -n "$ipf" ] || continue
  printf '%s' "$ipf" | grep -Eqi "$TOKEN" || continue
  if is_backed_global "$ipf"; then
    note "  SKIP (active-stack member, any region): InstanceProfile $ipf"
    continue
  fi
  if too_young "$created"; then
    note "  SKIP (younger than ${MIN_AGE_HOURS}h — likely an in-flight deploy): InstanceProfile $ipf"
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
done < <(aws iam list-instance-profiles --query 'InstanceProfiles[].[InstanceProfileName,CreateDate]' --output text 2>/dev/null)

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
# Pull each resource's own `aws:cloudformation:stack-name` tag alongside its ARN. That tag is the
# AUTHORITATIVE membership signal for the generic net: is_member matches the CFn PhysicalResourceId
# (a bare id/name like `vpc-0abc…`) but RGT hands us the full ARN (`arn:…:vpc/vpc-0abc…`), so the
# id-vs-ARN mismatch made a tagged member (a peer's live VPC/NACL/… whose id does not embed the
# stack name either) false-flag as an orphan — risking a `--delete` of a peer's active resource.
while IFS=$'\t' read -r arn cfn_stack; do
  [ -n "$arn" ] || continue
  # A resource CloudFormation still manages (its stack-name tag names an active/sentinel stack) is
  # never an orphan — honor that before the id/name heuristics below.
  if [ "$cfn_stack" != "None" ] && stack_is_active "$cfn_stack"; then
    note "  SKIP (active-stack member via aws:cloudformation:stack-name=$cfn_stack): $arn"
    continue
  fi
  # ARN already deleted by a per-type sweep above may still be listed briefly; the
  # active-stack guard + a existence-agnostic report is fine (verify re-runs later).
  if is_backed "$arn" || is_backed_global "$arn"; then
    note "  SKIP (active-stack member): $arn"
    continue
  fi
  if resource_gone "$arn"; then
    note "  SKIP (tagged mapping for an already-deleted resource — RGT tag-index lag): $arn"
    continue
  fi
  hit
  failed=$((failed + 1)) # unresolved by this script → keep verify RED until handled
  note "  ORPHAN (needs manual delete — delstack/console): $arn"
done < <(aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=cdkrd:ephemeral,Values=1 \
  --query 'ResourceTagMappingList[].[ResourceARN, Tags[?Key==`aws:cloudformation:stack-name`].Value | [0]]' \
  --output text 2>/dev/null)

note "=== summary: $found orphan(s) found, $failed delete failure(s) ==="
if [ "$found" -eq 0 ]; then
  note "SWEEP CLEAN"
fi
[ "$failed" -eq 0 ] || exit 1

---
name: sweep-resources
description: Discover and delete leftover cdkrd TEST AWS resources (ephemeral stacks plus stack-external orphans like IAM roles, log groups, RETAIN resources), then release the bughunt-clean gate. Use as the cleanup phase of /work-issues live-tests and /hunt-bugs, or standalone. NEVER touches non-cdkrd or production resources.
---

# Sweep cdkrd test resources

The safe cleanup entry point for real-AWS debris from live-tests and bug-hunts;
`/work-issues` and `/hunt-bugs` call it, and it runs standalone.

**Why it exists:** `delstack` deletes only stack MEMBERS; teardown leaves
stack-EXTERNAL orphans (auto-created `/aws/lambda/*` and API-GW CloudWatch **IAM
roles**, RETAIN-policy resources, Secrets in recovery, KMS pending deletion).
`sweep-orphans.sh` catches those, scoped STRICTLY to cdkrd name tokens
(`cdkrd|cdkdrift|cdkrealdrift`) plus a `cdkrd:ephemeral=1` tag net, never
touching a resource backed by an active stack.

## Safety invariants

- **Token-scoped only.** Everything below matches `Cdkrd*` / `CdkRealDrift*` /
  `Cdkdrift*` names or the `cdkrd:ephemeral=1` tag; a resource without a cdkrd
  token is out of scope — never delete it.
- **Never a production stack.** The account may hold the maintainer's prod
  stacks, so delete only UNIQUE test names (`Cdkrd<issue>Verify`, hunt
  fixtures). If a name is not obviously an ephemeral test resource, STOP and
  ask.
- **Protect peers.** `sweep-orphans.sh` skips any resource backed by an active
  stack (incl. `CREATE/UPDATE/DELETE_IN_PROGRESS`), matching the name
  case-insensitively and, for global IAM, across the region set
  `CDKRD_SWEEP_IAM_REGIONS` names — deploying outside that set makes an IAM role
  look unbacked. Still eyeball the dry-run: anything created TODAY by a peer
  live-test/hunt (a `wt-*` worktree exists, or the name matches another agent's
  issue) is theirs — leave it.
- **`delstack`, never `cdk destroy` / `aws cloudformation delete-stack`** —
  plain deletion orphans blocking members.

## Procedure

Set `REGION` (default `us-east-1`); run from a checkout.

### 1. Discover (read-only)

```bash
REGION=us-east-1
# a) leftover ephemeral stacks
aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName,'Cdkrd') || starts_with(StackName,'CdkRealDrift')].StackName" \
  --output text
# b) stack-external orphans
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh   # DRY RUN
```

Confirm every item is a cdkrd EPHEMERAL test resource, not a peer's in-flight
one; if anything is ambiguous, STOP and ask the maintainer.

### 2. Delete the leftover stacks

```bash
delstack -s <Stack> -r "$REGION" -y -f            # CFn-by-name
# or, from a fixture dir: delstack cdk -a cdk.out -r "$REGION" -f -y
```

### 3. Sweep the stack-external orphans

```bash
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh --delete
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh          # must print SWEEP CLEAN
```

The tag net reports a `cdkrd:ephemeral=1` resource of a type with no per-type
rule as `ORPHAN (needs manual delete …)` and keeps the sweep RED — delete those
and re-run until `SWEEP CLEAN`; a type never hides under a false CLEAN.

### 4. Release the bughunt-clean gate

`deploy-autoarm-gate` arms a PER-SESSION `autoarm-<session>` token on any
deploy, `/hunt-bugs` per-stack owners. Release only after §1–3 are clean:

```bash
TRACK=.claude/skills/hunt-bugs/bughunt-track.sh
# deploy-autoarm token for THIS session; the key is $CLAUDE_CODE_SESSION_ID,
# the SAME value the hook armed under:
AUTOARM="autoarm-$(printf '%s' "${CLAUDE_CODE_SESSION_ID:-shared}" | sed 's#[^A-Za-z0-9._-]#_#g')"
CDKRD_BUGHUNT_OWNER="$AUTOARM" "$TRACK" verify --region "$REGION"
CDKRD_BUGHUNT_OWNER="$AUTOARM" "$TRACK" clear
# this session's hunt owner (the one /hunt-bugs' `add` uses):
SESSION_OWNER="session-${CLAUDE_CODE_SESSION_ID:-shared}"
CDKRD_BUGHUNT_OWNER="$SESSION_OWNER" "$TRACK" verify --region "$REGION"
CDKRD_BUGHUNT_OWNER="$SESSION_OWNER" "$TRACK" clear
# The DEFAULT (main-root) owner: inspect first and clear ONLY if it holds no
# peer's stacks — a shared clear drops a peer's pending tracking.
"$TRACK" list
```

`verify` re-runs `sweep-orphans.sh` and `clear` REFUSES without a passing verify
stamp, so the gate cannot release while orphans remain. Run them separate and
un-piped — a `verify | tail && clear` pipeline once cleared on a FAILED verify.

### 5. Confirm

Remove any throwaway worktrees (`git worktree list`), then report what was
deleted and that `SWEEP CLEAN` plus the gate release happened. Repeat §1–4 per
region if you deployed to several.

## Ephemeral tagging

For the §3 tag net to catch types the per-type list misses, EVERY ephemeral
deploy carries `cdkrd:ephemeral=1`: **CDK app**
`Tags.of(app).add('cdkrd:ephemeral', '1')` (or per-stack); **raw CFn / SAM**
`aws cloudformation deploy --tags cdkrd:ephemeral=1 …`. That includes any
ad-hoc live-test, not just `/work-issues` and `/hunt-bugs` deploys.

---
name: sweep-resources
description: Discover and delete leftover cdkrd TEST AWS resources (ephemeral stacks + stack-external orphans like IAM roles, log groups, RETAIN resources), then release the bughunt-clean gate. Use as the cleanup phase of /work-issues live-tests and /hunt-bugs, or standalone to sweep test debris. NEVER touches non-cdkrd or production resources.
---

# Sweep cdkrd test resources

The single, safe cleanup entry point for the real-AWS debris that live-tests and
bug-hunts leave behind. It is the cleanup PHASE that `/work-issues` (live-test) and
`/hunt-bugs` call, and it is invocable standalone ("clean up my test resources").

**Why this exists:** `delstack` deletes only stack MEMBERS; teardown leaves
stack-EXTERNAL orphans (auto-created `/aws/lambda/*` and API-GW CloudWatch **IAM
roles**, RETAIN-policy stateful resources, Secrets in recovery, KMS pending deletion).
`sweep-orphans.sh` is the safety net for those, scoped STRICTLY to cdkrd name tokens
(`cdkrd|cdkdrift|cdkrealdrift`) + a generic `cdkrd:ephemeral=1` tag net, and it NEVER
touches a resource still backed by an active CloudFormation stack.

## Safety invariants (read first)

- **Token-scoped only.** Everything below matches `Cdkrd*` / `CdkRealDrift*` /
  `Cdkdrift*` names or the `cdkrd:ephemeral=1` tag. A resource without a cdkrd token
  is out of scope — never delete it.
- **Never a production stack.** The deploy account may hold the maintainer's prod
  stacks. Only ever delete UNIQUE test names (`Cdkrd<issue>Verify`, hunt fixtures).
  If a candidate name is not obviously an ephemeral test resource, STOP and ask.
- **Protect peers.** `sweep-orphans.sh` skips any resource backed by an active stack
  (incl. `CREATE/UPDATE/DELETE_IN_PROGRESS`), case-insensitively, across all project
  regions for global IAM. Still eyeball the dry-run: anything created TODAY by a peer
  live-test/hunt (a `wt-*` worktree exists, or the name matches another agent's issue)
  is theirs — leave it.
- **`delstack`, never `cdk destroy` / `aws cloudformation delete-stack`** (plain
  deletion orphans blocking members).

## Procedure

Set `REGION` (default `us-east-1`) and, for global-IAM protection, the region set the
project actually deploys to. The scripts live at the repo root; run from a checkout.

### 1. Discover (read-only — deletes nothing)

```bash
REGION=us-east-1
# a) leftover ephemeral stacks
aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName,'Cdkrd') || starts_with(StackName,'CdkRealDrift')].StackName" \
  --output text
# b) stack-external orphans (IAM roles, log groups, RETAIN resources, tagged-any-type)
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh   # DRY RUN
```

Review the output. Confirm every listed item is a cdkrd EPHEMERAL test resource and
not a peer's in-flight one (§ Safety). If anything is ambiguous, STOP and ask the
maintainer before deleting.

### 2. Delete the leftover stacks (if any)

For each confirmed-ephemeral stack (from a fixture dir with its `cdk.out`, or by name):

```bash
delstack -s <Stack> -r "$REGION" -y -f            # CFn-by-name
# or, from a fixture dir: delstack cdk -a cdk.out -r "$REGION" -f -y
```

### 3. Sweep the stack-external orphans

```bash
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh --delete
AWS_REGION="$REGION" bash tests/integration/sweep-orphans.sh          # must print SWEEP CLEAN
```

The generic tag net reports any `cdkrd:ephemeral=1` resource of a type the script has
no per-type rule for as `ORPHAN (needs manual delete …)` and keeps the sweep RED —
delete those with `delstack`/console, then re-run until `SWEEP CLEAN`. A type never
hides under a false CLEAN.

### 4. Release the bughunt-clean gate

The `deploy-autoarm-gate` hook arms a PER-SESSION `autoarm-<session>` token on any
deploy, and `/hunt-bugs` arms per-stack owners. Release only after §1–3 show clean:

```bash
# the deploy-autoarm token for THIS session (set by the deploy hook). The session key
# is $CLAUDE_CODE_SESSION_ID — the SAME value the hook armed under:
AUTOARM="autoarm-$(printf '%s' "${CLAUDE_CODE_SESSION_ID:-shared}" | sed 's#[^A-Za-z0-9._-]#_#g')"
CDKRD_BUGHUNT_OWNER="$AUTOARM" .claude/skills/hunt-bugs/bughunt-track.sh verify --region "$REGION"
CDKRD_BUGHUNT_OWNER="$AUTOARM" .claude/skills/hunt-bugs/bughunt-track.sh clear
# any per-owner hunt tracking (run verify + clear from the SAME worktree that armed):
.claude/skills/hunt-bugs/bughunt-track.sh verify --region "$REGION"
.claude/skills/hunt-bugs/bughunt-track.sh clear
```

`verify` re-runs `sweep-orphans.sh`; `clear` REFUSES without a passing verify stamp, so
the gate can never release while orphans remain. Run `verify` and `clear` as separate,
un-piped commands (a `verify | tail && clear` pipeline once cleared on a FAILED verify).

### 5. Confirm

```bash
git worktree list   # remove any throwaway worktrees you made
```

Report what was deleted and that `SWEEP CLEAN` + the gate is released. If you deployed
to more than one region, repeat §1–4 per region.

## Ephemeral tagging (makes the generic net work)

For the tag-based net (§3) to catch types the per-type list misses, EVERY ephemeral
test deploy should carry `cdkrd:ephemeral=1`:

- **CDK app:** `Tags.of(app).add('cdkrd:ephemeral', '1')` (or per-stack).
- **Raw-CFn / SAM:** `aws cloudformation deploy --tags cdkrd:ephemeral=1 …`.

`/work-issues` and `/hunt-bugs` add this to their deploy steps; do the same for any
ad-hoc live-test.

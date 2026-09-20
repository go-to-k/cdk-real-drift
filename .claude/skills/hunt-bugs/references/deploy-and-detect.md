<!-- Part of the /hunt-bugs skill. Stages 3–4. READ IN FULL when your run enters this stage. -->

### 3. Deploy (parallel, capped) + check

Run the `verify.sh` set in parallel (≤3–4). Each `verify.sh` MUST have a cleanup
`trap` that runs `delstack cdk -a cdk.out -r "$REGION" -f -y` (NOT `cdk destroy`) on
EXIT, so even a failed run deletes its stack. Triage every `result:` that is not
CLEAN, and scan the `info:` footer: a `skipped=` on a COMMON type is a read-gap many
users hit (an SDK-override candidate); an `unresolved=` points at declared values
whose intrinsics cdkrd could not resolve.

### 4. Test detection (the FN half)

For at least one common type, mutate a declared MUTABLE property out of band and
assert `check` detects → `revert` → `check` CLEAN → live value restored (reference:
`tests/integration/lambda-rich/verify-detect.sh`).

**When your FP fix ADDS a `KNOWN_DEFAULTS` fold for a MUTABLE prop AWS assigns,
live-test the REVERT of that value too — not just detection.** Mutate the folded prop
to a NON-default (it must re-surface — the equality gate still detects), `revert`,
confirm the live value returns. Some providers IGNORE an omitted property on update:
the default `remove` revert is a SILENT no-op — CC reports SUCCESS while the live
value persists (go-to-k/cdk-real-drift#597). Fix: add `${resourceType}\0${path}` to
`REVERT_SET_DEFAULT_PATHS` (RSDP, `src/revert/plan.ts`) so revert writes the default
EXPLICITLY.

**The revert-no-op class is NON-UNIFORM — live-prove EACH candidate, never predict
from the API shape.** A dedicated-toggle API does not imply a no-op: CC handlers often
RECONCILE full desired state and reset an omitted property
(go-to-k/cdk-real-drift#1571). It is non-uniform even WITHIN a type — ECR's policy
removes converge while its scalars no-op. Prove per-property, not per-type. Reference
fixture: `revert-toggle-converge`.

**Probe methods (cheapest first):**

- **Stackless CC probe** (when the resource is CC-creatable): `cloudcontrol
create-resource` → OOB-mutate → bare-`remove` probe → explicit-`add` probe → delete.
  The whole per-property proof for ~$0, no fixture (go-to-k/cdk-real-drift#1689).
- **Explicit-write probe before writing a fix**: `aws cloudcontrol update-resource
--patch-document '[{"op":"add","path":"/X","value":<default>}]'` against a
  CLI-created resource answers "does the explicit write converge?" with no stack.
- **Piggyback** the probe (mutate → revert → re-read) on every NEW `KNOWN_DEFAULTS`
  fold a hunt ships, while the stack is still up — nearly free.
- **A stackless probe that ERRORS proves nothing until you check the type's husk-table
  entry** (`CC_UPDATE_REJECTED_EMPTY_PATHS`, go-to-k/cdk-real-drift#1611): a property
  can fail raw and only prove convergent with a husk removal riding the patch.
- **Read-only probe targets** ("type not revertable yet"): restore OUT OF BAND before
  `revert`, or the fixture can never converge to zero.
- **Check upstream before pushing a same-table fix** — parallel sessions find the same
  rows on the same day.

**Revert-failure flavors and their fixes** (each live-proven; expect new ones):

1. **Silent bare-remove no-op** → RSDP entry (the base class). A type that rejects an
   empty string needs a placeholder value in the entry.
2. **Explicit `add` ALSO no-ops** — the handler ignores even an explicit write, so
   RSDP cannot converge it; fix = an `SDK_PROP_WRITERS` entry driving the dedicated
   API (go-to-k/cdk-real-drift#1619).
3. **Handler REJECTS the bare remove** — a hard error rather than a silent no-op,
   still an RSDP fix.
4. **Explicit default REJECTED while an incompatible sibling echo remains** in the CC
   read-modify-write model (a gp2 volume still carrying gp3 `Iops`) — fix =
   `REVERT_COMPANION_REMOVES` (plan.ts), so sibling `remove`s ride the same patch,
   gated on live-presence + not-declared (go-to-k/cdk-real-drift#1709).
5. **Type rejects EVERY CC patch** via a deprecated/successor API-alias pair in one
   model, so even a patch touching neither fails. Fix
   (go-to-k/cdk-real-drift#1752): TRANSLATE the deprecated ops to the successor side,
   companion-remove the deprecated projection, and remove the deprecated element LAST
   for index stability. Expect this class on any model carrying such a pair.
6. **DERIVED (tier-2) folds have NO revert-side value source unless you add one** —
   classify builds them into LOCAL knownDef maps, so RSDP sources the WRONG static
   value (an RDS read replica reverted `BackupRetentionPeriod` to 1 instead of the
   derived 0, silently enabling backups). `derivedRevertDefaultFor` (plan.ts) derives
   through the SHARED `src/normalize/derived-defaults.ts` helpers: **every future
   derived fold must add its resolver arm there plus a stackless convergence probe.**
7. **Revert-DELETE failure** — an `added` child's delete fails with
   `UnsupportedActionException` (no CC DELETE handler). When the service has a
   one-call delete, prefer an `SDK_DELETERS` entry over honest-notRevertable
   (go-to-k/cdk-real-drift#1431).
8. **`CONTEXT_ARN_DEFAULTS` pins** converge by adding the RSDP key alone, since
   plan.ts gained an `opts.identity`-resolved `contextArnDefaultFor` fallback in
   `revertOp` (go-to-k/cdk-real-drift#1694).

**Exclusions that are AWS-side, not cdkrd bugs** — do not spend a probe on a
rate-limited toggle (DynamoDB TTL 1/hour, EFS ThroughputMode 1/24 h, Kinesis
stream-mode exactly 2/24 h, leaving none for a retry) or a server-side irreversible
one (an SSM Parameter `Tier` cannot be downgraded). Record such a finding as a
detect-only note in code, not an issue.

**Writer audit** — ask "which SDK writers/deleters have ZERO live evidence?" and
mutate→detect→revert→live-assert them all on one nearly-free stack; re-run whenever a
few new writers accumulate. Two rules it produced: check every CFn-numeric /
API-string field when writing a writer (a numeric CFn `Amount` against an API that
models it as a STRING throws `SerializationException`, go-to-k/cdk-real-drift#1744);
and when a "not revertable" reason fires on a path a writer COULD serve, check the
bar's ORDERING — a generic gate can pre-empt the specific writer.

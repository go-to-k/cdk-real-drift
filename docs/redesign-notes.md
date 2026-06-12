# Pre-publication redesign decisions (2026-06-11)

The repo is not published yet, so breaking changes the final tool needs are made
now. Target = "detect drift INCLUDING undeclared CloudFormation properties, AND
revert it, as an effortless / friendly CLI."

## Decision 1 — three-verb model: check / accept / revert

Detect-only is no longer the identity. After `check` finds drift, the human
decision is binary, and the verbs mirror it:

| verb           | meaning                                                            | writes          |
| -------------- | ------------------------------------------------------------------ | --------------- |
| `cdkrd check`  | find drift (declared vs deployed template, undeclared vs baseline) | nothing         |
| `cdkrd accept` | "current state is RIGHT" — record it in the baseline file          | git file only   |
| `cdkrd revert` | "current state is WRONG" — write the desired value back to AWS     | AWS (confirmed) |

- declared drift reverts to the **deployed template** value.
- undeclared drift reverts to the **baseline** value; an out-of-band ADDITION
  (e.g. a PermissionsBoundary nobody declared) reverts by REMOVAL.
- `init` is removed (it duplicated accept; three verbs are the whole surface).

## Decision 2 — revert write path: Cloud Control UpdateResource (RFC6902)

Mirror of the read path: a generic Cloud Control `UpdateResource` JSON-patch
(`PatchDocument`, polled via `GetResourceRequestStatus`) for most types, plus
small SDK writers for the same CC-gap types the reader overrides
(PutBucketPolicy / SetTopicAttributes / SetQueueAttributes / IAM Put\*Policy /
Lambda add/remove-permission / Budgets update). No per-type update-provider fleet
(the cdkd approach) is needed.

Safety:

- revert prints the plan (per finding: path, current -> target) and asks for
  confirmation; `--yes` skips. Non-writable findings (readGap / unresolved /
  skipped / a CC type without an UPDATE handler) are listed as not-revertable.
- after apply, an automatic re-check verifies convergence.

## Decision 3 — first-run UX

`check` with no baseline on a TTY interactively offers: "No baseline found —
accept the current state now? [Y/n]" (CI / non-TTY keeps the note-only behavior).
Interactive prompts use `@clack/prompts` (same stack as cdk-local).

## Decision 4 — flag cleanup

- `--no-baseline` -> `--show-all` (inventory mode: ALL current undeclared values,
  not just changes since accept).
- `--region` no longer hard-defaults to us-east-1; resolve via the SDK default
  chain (env / profile) and fail with a clear message when unresolvable.

## Decision 5 — CDK-native via synth (`@aws-cdk/toolkit-lib`)

The engine is CloudFormation-generic (no synth needed to detect drift), but to be
authentically a CDK tool — and earn the name — we synth the CDK app with
`@aws-cdk/toolkit-lib` (same dependency cdk-local uses), giving:

- **stack auto-discovery** — `cdkrd check` with no stack args synths the app and
  checks every stack (like `cdk diff`).
- **construct-path display** — findings show `MyStack/MyBucket` (from the cloud
  assembly), not the synthesized logical id.
- **clobber / `--pre-deploy`** (later) — synth template vs deployed template =
  what the next deploy would overwrite; intersect with drift.
- **`--app`** flag (mirrors cdk CLI / cdk-local): a CDK app command
  (`node app.js`) OR a pre-synthesized cloud assembly dir (`cdk.out`). Falls back
  to `$CDK_APP` then `cdk.json`'s `"app"`.

Synth is the convenience/power layer; the drift COMPARISON itself is unchanged
(declared vs the DEPLOYED template, undeclared vs baseline).

**Update (R33):** cdkrd is now **CDK-only** — every run resolves the app (synth or a
pre-synthesized `cdk.out`) and operates only on the stacks the app defines. The
earlier "explicit `cdkrd check <stack>` with no app works synth-free" mode and
`--all` (CloudFormation `ListStacks` region scan) were removed: a no-app /
arbitrary-deployed-stack path is no longer supported. The COMPARISON is still
deployed-template vs live (synth only decides scope + construct-path labels), so the
core thesis is unchanged.

## Kept (re-validated, not changing)

- Baseline = git-committed `.cdkrd/<stack>.<accountId>.<region>.json`. With revert it is the
  _source of the undeclared target value_, so it is structural, not optional.
- The drift detection itself never calls CloudFormation's drift API and never
  _requires_ synth — synth only adds discovery / construct paths / clobber.

## Considered and rejected

- **Skipping `isTrivialEmpty` under `--show-all`.** `isTrivialEmpty` suppresses
  undeclared `false` / `''` / `[]` / `{}` values (AWS returns an "off/empty" value
  for nearly every unset option). One could argue inventory (`--show-all`) should
  show those so a user can see "feature X is explicitly off". Rejected: inventory
  would re-flood with exactly the `false`/empty noise the subtractive model exists
  to remove, drowning the real signal. The accepted-then-changed-to-empty case is
  still caught by baseline removal-detection, which is the case that matters.

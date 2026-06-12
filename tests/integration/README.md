# Integration tests (real AWS)

Each subdirectory is a self-contained CDK fixture + a `verify.sh` that runs the
full real-AWS loop and cleans up after itself (a trap destroys the stack and
removes the baseline even on failure — a failed run leaves no orphans).

Requires AWS credentials and a bootstrapped account (`cdk bootstrap`).

```bash
cd basic
npm install          # fixture's aws-cdk-lib + aws-cdk
bash verify.sh       # deploy -> accept -> check CLEAN -> inject drift -> check DETECTS -> destroy
```

`verify.sh` exits non-zero (and prints `INTEG FAIL: ...`) if any assertion fails;
prints `INTEG PASS` on success.

All accept/revert calls in the scripts pass `--yes`: since the interactive
prompts landed (R28/R38/R45), a write decision without `--yes` would refuse
(exit 2) when stdin is not a TTY — and stop to wait for input when it is (R50).

## Recording golden-corpus cases (R63)

Any `check` in these scripts (or a manual dogfood run) can double as corpus
recording: `CDKRD_CORPUS_DIR=/tmp/corpus bash verify.sh` writes one JSON case
per readable resource (pipeline inputs + findings, account ids sanitized).
Review a recording, add a `description`, and commit it under `tests/corpus/` —
the offline replay test then locks that classification in CI forever. Integ
fixtures use fictional names, so their recordings are always safe to commit;
never commit recordings from confidential stacks.

## When to run (R50)

These do NOT run in CI (they need credentials and mutate a real account):

- **Before every release** (the `/verify-pr` gate): run EVERY fixture —
  `basic` (+ `verify-deleted-guards.sh` + `verify-vs-cdk-drift.sh` +
  `verify-mutation-matrix.sh`), `iam`, `lambda`, `revert`, `policies`.
- **After changing** `src/read/**`, `src/revert/**`, `src/normalize/**`, or
  `src/commands/gather.ts`: run at least `basic` + `revert` (and `policies` if
  `writers.ts` changed) before merging.
- **After changing** `src/diff/**` or `src/baseline/**`: run
  `basic/verify-mutation-matrix.sh` (the drift-direction matrix) before merging.
- Scripts that share a fixture/stack (`basic`'s four) must run sequentially,
  never concurrently.

## basic

One versioned S3 bucket. Asserts:

1. `accept` then `check` reports CLEAN (exit 0).
2. After enabling transfer acceleration out-of-band (an **undeclared** change CFn
   drift would not catch), `check` reports drift (exit 1) and names
   `AccelerateConfiguration`.

### basic / verify-deleted-guards.sh

A second script in the `basic` fixture (reuses its bucket) covering the `deleted`
tier and the `revert` guards:

1. **R2 revert guard** — with NO baseline, `revert --dry-run` reports the
   undeclared value as `NOT revertable` (`unrecorded`, R62) while a declared drift
   is still in the plan; `--remove-unaccepted` opts in to removing it.
2. **R1 deleted tier** — after deleting the bucket out of band, `check` reports the
   `deleted` tier (exit 1) and `revert --dry-run` reports it as not revertable
   (`deleted — recreate via cdk deploy`).

```bash
cd basic && bash verify-deleted-guards.sh
```

### basic / verify-vs-cdk-drift.sh

Empirical proof of the README capability table, against `cdk drift` itself
(reuses the `basic` stack; needs an aws-cdk with the `drift` command):

1. After an **undeclared** change (transfer acceleration), `cdk drift --fail`
   exits 0 (CFn drift detection cannot see it) while `cdkrd check` exits 1 and
   names `AccelerateConfiguration` — the differentiator, demonstrated.
2. After a **declared** change (versioning suspended), BOTH detect it — cdkrd
   is a superset, not a sidegrade.

If `cdk drift` ever starts detecting the undeclared change, this test fails —
the signal to re-verify the README comparison-table claims.

### basic / verify-mutation-matrix.sh

False-negative matrix (R64): after a FULL accept (snapshot-complete baseline),
one bucket is walked through every drift direction the model distinguishes;
each must be detected, named, and resolved back to CLEAN:

| #   | direction         | mutation                        | must name                            | resolve  |
| --- | ----------------- | ------------------------------- | ------------------------------------ | -------- |
| M1  | declared-change   | versioning suspended            | `VersioningConfiguration`            | `revert` |
| M2  | undeclared-add    | acceleration appears            | `appeared since accept` (R62)        | `accept` |
| M3  | undeclared-change | accepted acceleration flips     | `AccelerateConfiguration`            | `accept` |
| M4  | undeclared-add    | out-of-band bucket tags         | `Tags` + `appeared since accept`     | `accept` |
| M5  | value-remove      | accepted tags deleted           | `baseline value removed since accept`| `accept` |

Every mutation ends at CLEAN, so the script also exercises the accept delta
loop (R39) each round and the declared revert path once.

```bash
cd basic && bash verify-mutation-matrix.sh
```

## iam / lambda

IAM Role (inject a permissions boundary → undeclared drift) and a Node Lambda
(inject reserved concurrency → undeclared drift); each asserts detect + clean destroy.
The IAM fixture role also carries a CDK-generated sibling `AWS::IAM::Policy`
(`addToPolicy` → DefaultPolicy), so the boundary test doubles as a no-false-positive
check for the sibling filter.

### iam / verify-inline-policy.sh

A second script in the `iam` fixture covering the sibling-DefaultPolicy blind
spot end-to-end (an out-of-band inline policy on a role whose grants live in a
sibling `AWS::IAM::Policy`):

1. `accept` then `check` reports CLEAN — the sibling DefaultPolicy entry in the
   role's live `Policies` is filtered by name, not reported as drift.
2. After `put-role-policy` adds a rogue inline policy out-of-band, `check` reports
   `Policies` drift (exit 1) naming ONLY the rogue policy — the sibling entry does
   not leak into the finding.
3. `revert --yes` deletes ONLY the rogue policy (per-name `DeleteRolePolicy`, not a
   whole-property Cloud Control patch): the DefaultPolicy survives with its
   document intact, and `check` is CLEAN again.

```bash
cd iam && bash verify-inline-policy.sh
```

## revert

A versioned S3 bucket. Enables acceleration, `accept`s (recording it in the
baseline), then injects a DECLARED drift (versioning suspended) + an UNDECLARED
drift (acceleration suspended from its accepted Enabled), asserts `check` detects
both, runs `cdkrd revert --yes`, and asserts `check` is CLEAN and AWS itself
converged (versioning Enabled = template, acceleration Enabled = baseline value).
Proves the Cloud Control `UpdateResource` write path end-to-end.

## policies

One resource per SDK writer (`SDK_WRITERS` in `src/revert/writers.ts`):
`AWS::S3::BucketPolicy`, `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`,
`AWS::IAM::Policy` (standalone inline), `AWS::IAM::ManagedPolicy`. After
accept + CLEAN, a `CdkrdInjected` statement is spliced into EVERY policy
document out of band; asserts `check` reports all 5 declared drifts, `revert
--yes` converges through all 5 writers, `check` is CLEAN again, and direct AWS
reads confirm the injected statement is gone while the declared one survived
(for the managed policy: on the new default version). Covers the SDK-override
read path AND the SDK write path for every writer type end-to-end.

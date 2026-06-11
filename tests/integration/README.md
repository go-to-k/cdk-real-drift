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
   undeclared drift as `NOT revertable` (`no baseline`) while a declared drift is
   still in the plan; `--remove-unblessed` opts in to removing the undeclared value.
2. **R1 deleted tier** — after deleting the bucket out of band, `check` reports the
   `deleted` tier (exit 1) and `revert --dry-run` reports it as not revertable
   (`deleted — recreate via cdk deploy`).

```bash
cd basic && bash verify-deleted-guards.sh
```

## iam / lambda

IAM Role (inject a permissions boundary → undeclared drift) and a Node Lambda
(inject reserved concurrency → undeclared drift); each asserts detect + clean destroy.

## revert

A versioned S3 bucket. Enables acceleration, `accept`s (baseline blesses it), then
injects a DECLARED drift (versioning suspended) + an UNDECLARED drift (acceleration
suspended from its blessed Enabled), asserts `check` detects both, runs
`cdkrd revert --yes`, and asserts `check` is CLEAN and AWS itself converged
(versioning Enabled = template, acceleration Enabled = blessed). Proves the
Cloud Control `UpdateResource` write path end-to-end.

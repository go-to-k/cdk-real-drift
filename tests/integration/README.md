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

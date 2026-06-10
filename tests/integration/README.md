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

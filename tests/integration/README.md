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
  `verify-mutation-matrix.sh`), `iam`, `lambda`, `revert`, `policies`, `atdefault`,
  `noise`, `readgap`, and the false-positive matrix (`dynamodb`, `sqs`,
  `securitygroup`, `cloudwatch-alarm`, `stepfunctions`, `ssm`, `eventbridge`,
  `cognito`).
- **After changing** `src/read/**`, `src/revert/**`, `src/normalize/**`, or
  `src/commands/gather.ts`: run at least `basic` + `revert` + `noise` + the
  false-positive matrix (below — each asserts tricky declared values normalize
  equal to live, never a false declared drift) (and `policies` if `writers.ts`
  changed; `harvest3` for the multi-type Cloud Control revert matrix) before merging.
- **After changing** `src/diff/**` or `src/baseline/**`: run
  `basic/verify-mutation-matrix.sh` (the drift-direction matrix) before merging.
- **After changing** `KNOWN_DEFAULTS` (`src/normalize/noise.ts`) or the
  `atDefault` fold: run `atdefault` — it asserts the hand-written default shapes
  still match live Cloud Control output (a shape mismatch would resurface the
  value as real undeclared drift) and that a value changed away from its default
  still surfaces.
- Scripts that share a fixture/stack (`basic`'s four) must run sequentially,
  never concurrently.
- **After changing exit-code or baseline semantics** (report-only/--fail, the
  UNRECORDED contract, prompt flows): re-run EVERY script. They assert exit
  codes and grep output wording, and have now broken on three such changes
  (R55, R62, R70) — each found only on the next live run.

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
| M4  | undeclared-add    | out-of-band CORS config         | `CorsConfiguration` + `appeared since accept` | `accept` |
| M5  | value-remove      | accepted CORS deleted           | `baseline value removed since accept`| `accept` |

Every mutation ends at CLEAN, so the script also exercises the accept delta
loop (R39) each round and the declared revert path once. (M4/M5 use CORS, not
tags: S3 refuses a TagSet replacement that drops the CFn `aws:*` system tags —
found on the first live run, R68.)

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

## atdefault

Validates the R86 `atDefault` fold end-to-end (a default-config Lambda + a bare
L1 S3 bucket, whose undeclared properties all sit at a known AWS default):

1. **before any baseline**, those values FOLD into the `atDefault` tier — they are
   counted in the `info:` footer but NOT listed in the report body. This proves the
   hand-written `KNOWN_DEFAULTS` shapes (especially the S3 `BucketEncryption` shape
   with `BlockedEncryptionTypes`) still match what Cloud Control returns; a mismatch
   would reclassify the value as real undeclared and surface it in the body.
2. `--show-all` expands the fold and lists those same values under `AT AWS DEFAULT`.
3. after `accept`, `check` is CLEAN (the at-default values fold, never recorded).
4. mutating one at-default value away from its default (Lambda `TracingConfig`
   `PassThrough` → `Active`) makes `check` surface it as real drift — the fold
   never blinds cdkrd to an actual change (the equality gate has teeth).

```bash
cd atdefault && bash verify.sh
```

## noise

The false-positive guard. Deploys resources that DECLARE properties whose live
AWS form is textually different from the template but semantically identical —
exactly what the `normalize/` layer subtracts:

- an IAM inline policy with an `aws:SecureTransport` **Condition** key (R69
  regression: it must survive the live read, NOT be stripped as an `aws:*` tag),
  multi-action statements, and a managed policy attached by name (name↔ARN);
- resource **Tags** AWS augments with `aws:cloudformation:*` and may reorder;
- an S3 **CorsConfiguration** (ordered array of rules).

The assertion is the strong one: with NO baseline, `check --fail` must exit `0` —
there is no declared drift, because every declared value normalizes equal to live.
A normalizer regression turns one of these into a false declared drift and fails.

```bash
cd noise && bash verify.sh
```

## readgap

The honest-gap guard (the other direction). Some declared properties genuinely
cannot be read back — a write-only value is the canonical case. A change to one out
of band IS real drift cdkrd cannot verify; the promise is to say so honestly
(`readGap`) rather than silently pass it as CLEAN. Deploys a SecretsManager secret
with a literal write-only `SecretString` and asserts it surfaces in the `readGap`
tier (reason: `write-only`), never silently absent; `--fail` still exits `0` (a
readGap is informational, not drift). The cleanup trap force-deletes the secret.

```bash
cd readgap && bash verify.sh
```

## false-positive matrix

Eight focused fixtures (R88), each the same shape as `noise`: deploy a resource that
DECLARES a property whose live AWS form is textually different but semantically
equal, then assert `check --fail` exits `0` with no baseline — zero false declared
drift. They target the specific normalization classes most likely to regress:

| fixture            | resource             | noise-prone declared property (class)                                  |
| ------------------ | -------------------- | ---------------------------------------------------------------------- |
| `dynamodb`         | DynamoDB Table       | KeySchema / AttributeDefinitions / GSIs (ordered arrays), tags         |
| `sqs`              | SQS Queue + DLQ      | RedrivePolicy (object↔JSON-string, R75), numeric attributes            |
| `securitygroup`    | EC2 SecurityGroup    | ingress/egress rules (unordered arrays of CIDR rule objects)           |
| `cloudwatch-alarm` | CloudWatch Alarm     | Dimensions (unordered `{Name,Value}` array — NOT Key/Id-keyed)         |
| `stepfunctions`    | Step Functions SM    | DefinitionString (JSON string, R75) + auto-role policy                 |
| `ssm`              | SSM Document + Param | Document Content (object↔JSON-string, R75)                             |
| `eventbridge`      | EventBridge Rule     | EventPattern (object↔JSON-string), Targets array + queue policy        |
| `cognito`          | Cognito Pool/Client  | OAuth/ExplicitAuthFlows (unordered enums, R74), UserPoolGroup id (R84) |

```bash
cd dynamodb && bash verify.sh   # …and likewise for each fixture above
```

## harvest

A corpus-harvest fixture (R71): ~18 cheap, fast-create/delete types in one
stack (DynamoDB, EventBridge Bus+Rule, Step Functions SM+Activity, Athena
WorkGroup, CloudWatch Alarm+Dashboard, LogGroup+MetricFilter, ECR, SSM,
HTTP API, REST API, CodeBuild, IAM User, EIP, Glue Database+Table). Asserts:

1. A FRESH deploy classifies with **zero declared drift** across every type
   (the cross-type false-positive test) and exits 0 (inventory is UNRECORDED).
2. `accept --yes` then `check --fail` lands CLEAN across every type.

Run with `CDKRD_CORPUS_DIR` to record one golden-corpus case per type — the
fixture exists to convert one AWS round trip into permanent offline coverage.

```bash
cd harvest && npm install && bash verify-harvest.sh
```

## harvest2

Wave 2 of the corpus harvest (R73): RICHLY-DECLARED configurations — S3
lifecycle+CORS, DynamoDB GSI+TTL+stream, Lambda with non-default
memory/timeout/arch/tracing/env, FIFO queues with redrive, SNS->SQS
subscription with a filter policy, EventBridge input transformer, WAFv2
WebACL with a managed rule group, ECS cluster (pulls in a full VPC: subnets,
routes, NAT, IGW — all recorded), Kinesis with the aws-managed KMS alias
(exercises the strict alias<->key-ARN match live). Asserts the same two
invariants as `harvest`: fresh deploy = ZERO declared drift, then
accept -> `check --fail` CLEAN.

```bash
cd harvest2 && npm install && bash verify-harvest2.sh
```

## harvest3

Wave 3 of the corpus harvest (R74), two jobs in one deploy:

- **New service families** the corpus had never seen live: Cognito
  UserPool+Client, KMS Key+Alias, Secrets Manager, EventBridge Scheduler
  (group + schedule), Firehose delivery stream, SES configuration set,
  Cloud Map HTTP namespace, AppSync GraphQL API, CloudTrail trail, AWS
  Backup vault+plan. Same two harvest invariants: fresh deploy = ZERO
  declared drift, then accept -> `check --fail` CLEAN.
- **Multi-type revert matrix** — the first live proof of the Cloud Control
  write path beyond S3. Five CC-routed declared values are mutated
  out-of-band (Lambda `MemorySize`, SQS `VisibilityTimeout`, Logs
  `RetentionInDays`, SNS `DisplayName`, Events Rule `State`); ONE `check`
  must report exactly 5 declared drifts, ONE `revert --yes` must restore
  all five, verified by `check --fail` CLEAN and direct per-service AWS
  reads.

With `CDKRD_CORPUS_DIR` set, the drift-state recordings are snapshotted to
`${CDKRD_CORPUS_DIR}.drifted` before the post-revert check overwrites them —
one run yields BOTH a clean and a drifted corpus case per matrix type.

```bash
cd harvest3 && npm install && bash verify-harvest3.sh
```

## harvest4

Wave 4 of the corpus harvest (R75): the remaining high-frequency families —
ALB + target group + listener (1-AZ-pair VPC, no NAT), EFS with mount
targets, Route53 public zone with an ALIAS record to the ALB (runs the
Route53 SDK reader's AliasTarget path live) + TXT record, Cognito
IdentityPool, DynamoDB Application Auto Scaling (ScalableTarget +
target-tracking policy), SSM Document, HTTP API with an explicit throttled
stage, ECR with a lifecycle policy. Same two harvest invariants, plus a
Key-scoped attribute-bag detect-and-revert: the declared `idle_timeout`
lives inside the `{Key,Value}[]` LoadBalancerAttributes bag — the template
declares 2 of ~23 attributes — so an out-of-band change to it must surface
as exactly ONE declared drift named by Key
(`LoadBalancerAttributes[idle_timeout.timeout_seconds]`). `revert --yes`
then restores it via the ELB SDK writer (`ModifyLoadBalancerAttributes`
with only the declared Key=Value, NOT a Cloud Control index patch — which
misaligns against the full live bag and exceeds ELB's 20-attribute cap,
R78), confirmed by a direct ELBv2 read. `CDKRD_HARVEST4_KEEP=1` keeps the
stack for debug iteration.

```bash
cd harvest4 && npm install && bash verify-harvest4.sh
```

## cloudfront

CloudFront Distribution (R75) — the most config-dense type, previously
covered only by hand-written corpus seeds. Two origins (S3 with OAC + HTTP)
and two behaviors so the Id-keyed Origins sort, the HTTP-method enum-set
sort, and the cache-policy reference shapes all run against real data.
Asserts the two harvest invariants (fresh deploy = ZERO declared drift,
accept -> CLEAN). Kept separate from the harvest waves because deploy and
destroy each take minutes. `CDKRD_CLOUDFRONT_KEEP=1` keeps the stack.

```bash
cd cloudfront && npm install && bash verify-cloudfront.sh
```

## harvest5

Wave 5 of the corpus harvest (R77): long-tail family breadth — AppConfig
(application + environment + configuration profile + deployment strategy),
EventBridge Connection + ApiDestination + Archive, Glue Job + Trigger,
Lambda Function + Alias, IAM InstanceProfile, Route53 HealthCheck, a
CloudWatch CompositeAlarm over two child alarms, an EXPRESS StateMachine,
and an SSM Parameter. All cheap and fast — no VPC, no NAT, no slow
resources. Same two harvest invariants: fresh deploy = ZERO declared drift,
then accept -> `check --fail` CLEAN.

```bash
cd harvest5 && npm install && bash verify-harvest5.sh
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

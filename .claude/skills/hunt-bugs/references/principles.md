<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

## Default posture: assume many latent bugs remain — sweep wide, ~5 rounds

Unless the user scopes it down, assume **plenty of latent bugs remain** — every past
sweep surfaced fresh FP/FN classes; the fold/normalize tables are known-incomplete
allowlists. Defaults:

- **Do ~5 rounds**, each a fresh angle on fresh common-but-untested types/configs. A
  clean round means change the angle, not stop early.
- **Vary the lens every round**: first-run undeclared FP (fold gaps), declared-tier
  normalization FP, missed-detection FN (out-of-band mutate of a declared mutable
  prop), write-only / read-gap FN, revert non-convergence (silent no-op /
  husk-poisoned patch), composite-identifier read skips, offline corpus mining.
  Menu = "Core principles" below + `references/gotchas.md`; pick a different mix
  each round.
- **Parallelize within the 3–4 stack cap**, unique stack names so concurrent
  agents/sessions never collide.

A narrower scope happens only when the user asks for it.

## Goal: filing issues vs. fixing — ASK at run time unless told

A hunt can stop at **filing GitHub issues** or go through **fix + PR + merge** —
very different in cost, blast radius, and parallel-agent collision risk. **Unless
the user explicitly stated the goal, ASK at the start of the run**: a wrong
assumption wastes a fix that collides with a parallel agent, or stops short of a fix
the user wanted.

- **Issue-only** — investigate, live-verify, harvest corpus, FILE well-scoped issues
  (repro + recommended fold/fix); do NOT change `src/`. Best when other agents work
  filed issues in parallel, or the user wants to review first.
- **Fix + PR** — additionally root-cause, fix in `src/`, add the unit test, keep the
  fixture, carry through PR (per "On a confirmed bug" + the merge steps).

Skip the question only when the user already named one ("stop at filing the issues"
/ "just report" = issue-only; "fix it" / "fix and PR" = fix).

## Core principles

1. **Many-people-hit beats niche.** Prioritize what most CDK users deploy daily —
   S3 (encryption/lifecycle/CORS/intelligent-tiering), Lambda (arm64/env/tracing/
   reserved-concurrency/FunctionUrl/logGroup), VPC (subnets/NAT/routes/endpoints),
   DynamoDB, IAM, API Gateway, ECS/Fargate, RDS, SQS/SNS, CloudFront — a
   daily-pattern bug is worth ten niche ones.
2. **The two signals ARE the priority — hunt FP and FN above all else.** FP (drift
   reported that isn't real) and FN (real drift missed) are what damage user trust;
   incidental findings (a crash, a read-gap `skipped=`, cosmetic output) are worth
   noting but not the target. A fresh deploy with NO out-of-band change is the
   cleanest oracle:
   - **False positive (FP)** — most user-damaging. Post-`record`, `check` MUST be
     CLEAN: `record` snapshots only the UNDECLARED dimension, so surviving drift =
     a declared-dimension normalization/fold bug. **Invariant (CLAUDE.md /
     DESIGN.md): a clean, un-mutated deploy shows ZERO `[Potential Drift]` even on
     `check` BEFORE `record`** — an undeclared creation-time value is a default and
     MUST fold to `atDefault`; `[Potential Drift]` = REAL divergence only (user or
     AWS change AFTER creation) — so on a fresh fixture **every entry = fold gap =
     bug.** Uncertain default → verify what AWS assigns
     to a fresh minimal config; never ship it as "conservative" or rationalize
     `undeclared` as "honest"; N→"a few" is not a fix — target zero. Fold via the
     CLAUDE.md **fold-strategy decision order** (first match wins): (1)
     equality-gated constant (`KNOWN_DEFAULTS` / `KNOWN_DEFAULT_PATHS`) — detection
     kept; (2) **derived** default (`CONTEXT_DEFAULTS` = f(region),
     `ENGINE_DEFAULTS` = f(engine), or f(sibling/declared prop) — EB `MaxSize` from
     `EnvironmentType`) when deterministic in declared inputs, detection kept —
     **ask "can I DERIVE it?" before calling a default "context-dependent, can't
     fold"**; (3) value-independent ONLY as a last resort — a default AWS moves
     (platform AMI, versioned URL, GA version) or an unpinnable per-resource
     identifier/cosmetic value; loses detection, acceptable only because
     undeclared (a user who cares declares it).
   - **False negative (FN) / missed detection** — `record`→`check`→CLEAN does NOT
     exercise detection: ALSO mutate a **declared, MUTABLE** prop out of band
     (console-change scenario — Lambda `MemorySize`/`Timeout`, SQS
     `VisibilityTimeout`); assert `check` DETECTS it (exit 1), `revert` restores,
     `check` CLEAN. Create-only/immutable props (Subnet AZ, NAT AllocationId)
     can't drift — pick a MUTABLE one.
3. **Check coverage first.** Before building anything, `grep` the fixtures to hunt
   in genuinely-uncovered territory:

   ```bash
   grep -rln "Kinesis\|Dashboard\|Secret\|intelligentTiering\|FunctionUrl" tests/integration/*/app.ts
   ```

   Empty hits = untested = good ground. A NON-empty hit does **NOT** cover the
   undeclared-default scenario: a case that DECLARES the suspect prop never
   exercises the undeclared fold, so a first-run FP stays latent under apparent
   coverage (`Events::ApiDestination` `InvocationRateLimitPerSecond` — declared in
   the corpus, hiding the undeclared-300 FP; go-to-k/cdk-real-drift#615). Before
   skipping a "covered" type, grep the fixture `app.ts` / corpus `declared` block —
   if every case declares it, the path is still open.

   **The single most reliable FP-finder: deploy each priority type in its BAREST
   config — one type at a time — and `check` immediately (before `record`).**
   Declaring only what CFn REQUIRES (e.g. RDS `DBInstance`: `engine` /
   `dbInstanceClass` / `allocatedStorage` / master creds) leaves the MOST props
   undeclared → the MOST default-folds exercised, where first-run FPs live; a rich
   fixture HIDES them. Loop: **minimal deploy → immediate `check` → fold every
   `[Potential Drift]` to zero → next type.** **Cover the type's COMMON VARIANTS
   minimally too** — a default is often f(mode/family/engine), so an undeployed
   variant is an unguarded gap: the Aurora/`DBCluster`-centric RDS folds left a
   minimal non-Aurora `DBInstance` first-running FPs on `StorageType` (`gp2` —
   `aurora`-only fold), `BackupRetentionPeriod` (`DBCluster` only), and undeclared
   `EngineVersion` (go-to-k/cdk-real-drift#1477). Enumerate the axes (RDS
   provisioned vs Aurora, per-engine; ElastiCache redis/valkey/memcached; ECS EC2
   vs Fargate; create-only vs mutable form) and deploy each branch's MINIMAL form —
   green on ONE variant proves nothing about the others.

4. **Probe CC support BEFORE an expensive deploy — skip the CC-gap tail.** For a
   high-cost/slow stateful type (RDS-family, OpenSearch, MSK, Neptune, DocumentDB,
   Cloud Map, …), first check Cloud Control can even READ it — the hunt only has
   traction on **CC-readable** types. `UnsupportedActionException` on read → every
   resource `skipped=N` (surfaced in the `info:` footer — NOT a false negative):
   clean `record`→`check` is hollow, a detect invisible — zero FP/FN yield, no
   fixture value; an `SDK_OVERRIDES` reader candidate (separate feature task), not
   a hunt target. Do NOT burn a paid deploy; confirm first:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'ProvisioningType'   # FULLY_MUTABLE/IMMUTABLE = provisionable; then probe READ:
   # if you have a live instance, `cloudcontrol get-resource` — UnsupportedActionException = CC-gap
   ```

   (Confirmed CC-gap: ServiceDiscovery HttpNamespace+Service, DocumentDB
   DBCluster/DBInstance, AppSync ApiKey/GraphQLSchema — `SDK_OVERRIDES` candidates.)

   The INVERSE is prime ground: an `SDK_OVERRIDES` / `SDK_SUPPLEMENTS` entry with
   **zero corpus cases and zero fixtures** was added from a live FN report without
   ever exercising the barest first-run path — deploy its minimal form first (the
   RedshiftServerless Workgroup trio, go-to-k/cdk-real-drift#1489; ACM Certificate
   / ELBv2 TrustStore / DAX / MediaConvert / SageMaker EndpointConfig / ClientVPN
   remain unexercised).

   **A `read` handler is NOT enough — also check the `primaryIdentifier` ARITY.** A
   COMPOSITE `primaryIdentifier` (>1 segment) whose CFn physical id is only the
   CHILD segment makes CC `GetResource` reject the bare id → silently `skipped`
   with `ValidationException` (a DIFFERENT read-gap class than
   `UnsupportedActionException`). Fix = `CC_IDENTIFIER_ADAPTERS` (derive the
   `parent|child` / `child|parent` composite from the resolved declared Ref), NOT
   `SDK_OVERRIDES`. Probe offline:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'Schema' --output text | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['primaryIdentifier'])"
   ```

   Length > 1 + CC-`read`-able + NOT already in `CC_IDENTIFIER_ADAPTERS` /
   `SDK_OVERRIDES` + CFn `Ref` returns only the child segment → a likely
   declared-read gap worth a cheap deploy to confirm the composite ORDER
   (unreliable to guess — verify live, e.g. `aws cloudcontrol get-resource`).
   Confirmed: Logs SubscriptionFilter (`FilterName|LogGroupName`, PR
   go-to-k/cdk-real-drift#344). **But weight by GENERATION: registry-era types are
   overwhelmingly NATURAL composites** (physical id already the `seg1|seg2` join —
   CC reads as-is, no adapter): a one-stack probe of 7 uncovered composite-pi
   registry-era types all read clean, zero `skipped`. The gap class lives in
   LEGACY types that kept a bare-segment physical id when registry-migrated (the
   ~40 existing adapters are all that class); an association-pack probe is still
   worth it, but expect "no gap" as the common outcome.

5. **Predict FP classes from the fold allowlists, then audit them OFFLINE before
   any paid deploy.** The per-type fold tables in `src/normalize/noise.ts` ARE the
   inventory of FP classes already found — mostly CURATED, KNOWN-INCOMPLETE
   allowlists (`CASE_INSENSITIVE_PATHS`, `VERSION_PREFIX_PATHS`,
   `UNORDERED_ARRAY_PROPS` / `UNORDERED_OBJECT_ARRAY_PROPS` /
   `UNORDERED_NESTED_OBJECT_ARRAY_PATHS`, `RATE_EXPRESSION_PATHS`,
   `EPOCH_HOUR_PATHS`, `TRAILING_DOT_PATHS`). Each lists only the 1–2 types someone
   already hit; **any OTHER type sharing that semantic divergence is an unguarded
   gap** — PREDICT where FPs hide instead of deploying blind:
   - Recurring FP axes (live value ≡ declared but ≢ structurally): **set-like
     array reorder** (DNS RecordSet values, Cognito URL/OAuth lists, WAF sets, SG
     rules), **partial→concrete version**
     (`*Version`/`EngineVersion`/`KafkaVersion` a service expands),
     **case-insensitive enum** (`*Type`/`*Protocol`/`*Status`), **trailing/format
     normalization** (FQDN dot, ARN `:*`, rate(), epoch), **object↔JSON-string
     shape** (a `Definition`/`Content`/policy declared as object, read back as
     string). Suspect any prop named `*Version`/`*Type`/`*Protocol`/`*Status`/
     trailing-`Name`(FQDN)/`*Arn`/`Schedule*`/map-type/order-insensitive array.
   - **Audit the gap OFFLINE first (free).** Per candidate: read the allowlist,
     then grep `tests/corpus/*.json` comparing `resource.declared` vs `liveRaw`. A
     recorded live read EXHIBITS the divergence and `expected` is clean → already
     covered+guarded (`corpus-replay` proves it), skip. No corpus case exercises
     the trigger (a RecordSet case with ONE value never tests multi-value
     reorder), or the service can't produce the divergence (MSK rejects a partial
     version → declared==live, NO risk) → that determination is the deliverable.
     Only deploy genuine, reproducible gaps — this ruled out ~10 wasteful deploys
     in the go-to-k/cdk-real-drift#303 hunt. Fan out parallel read-only agents
     (one per class). A confirmed gap's fix is usually a one-line allowlist
     addition + unit test + corpus case.
6. **Parallelize, but cap at 3–4 stacks.** Independent stacks (unique names) deploy
   concurrently as background tasks; more makes logs and teardown hard to follow.
   VPC/NAT (~3 min) pace a wave; most others ~1–2 min.

<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

## Default posture: assume many latent bugs remain — sweep wide, ~5 rounds

Unless the user scopes it down, run this hunt on the working assumption that **there
are still plenty of latent bugs left to find** — every past sweep has surfaced fresh
FP/FN classes, and the fold/normalize tables are known-incomplete allowlists. So by
default:

- **Do ~5 rounds**, not one. Each round is a fresh angle on a fresh set of
  common-but-untested types/configs. Treat one clean round as a signal to change the
  angle, not to stop early — keep going until ~5 rounds are done or the user says
  enough.
- **Vary the lens every round** — don't just deploy more resource types. Rotate
  through the angles that expose different bug classes: first-run undeclared FP
  (fold gaps), declared-tier normalization FP, missed-detection FN (mutate a declared
  mutable prop out of band), write-only / read-gap FN, revert non-convergence
  (silent no-op / husk-poisoned patch), composite-identifier read skips, and the
  offline corpus-mining sweep. The catalogue in "Core principles" (below) +
  `references/gotchas.md` is the menu; pick a different mix each round.
- **Parallelize within the 3–4 stack cap** and keep stack names unique so concurrent
  agents/sessions never collide.

"5 rounds, many angles, latent bugs assumed" is the DEFAULT — a narrower scope
happens only when the user asks for it.

## Goal: filing issues vs. fixing — ASK at run time unless told

The end state of a hunt is not fixed. It can stop at **filing GitHub issues** for
what it finds, or go all the way to **fixing + PR + merge**. These are very different
in cost, blast radius, and collision risk with parallel agents. **So unless the user
has explicitly stated the goal in their invocation, ASK them at the start of the run
which they want** — do not assume. Typical options to offer:

- **Issue-only** — investigate, live-verify, harvest corpus, and FILE well-scoped
  issues (with the repro + recommended fold/fix), but do NOT change `src/`. Best when
  other agents are working filed issues in parallel, or the user wants to review
  before any fix lands.
- **Fix + PR** — additionally root-cause, fix in `src/`, add the unit test, keep the
  fixture, and carry it through PR (per "On a confirmed bug" + the merge steps).

Only skip the question when the user already named one — "stop at filing the
issues" / "just report what you find" means issue-only, "fix it" / "fix and PR"
means fix. When in doubt, ASK — a wrong assumption here either wastes a fix that
collides with a parallel agent, or stops short of a fix the user wanted.

## Core principles

1. **Many-people-hit beats niche.** Prioritize the resources/configs a large
   fraction of CDK users deploy every day — S3 (encryption/lifecycle/CORS/
   intelligent-tiering), Lambda (arm64/env/tracing/reserved-concurrency/
   FunctionUrl/logGroup), VPC (subnets/NAT/routes/endpoints), DynamoDB, IAM, API
   Gateway, ECS/Fargate, RDS, SQS/SNS, CloudFront — over exotic edge cases. A bug
   in a daily pattern is worth ten niche ones.
2. **The two signals ARE the priority — hunt FP and FN above all else.** False
   positives (drift reported that isn't real) and false negatives (real drift
   missed) are the bug classes this hunt exists to find; they are what actually
   damages a user's trust in the tool. Prioritize provoking and confirming them over
   incidental findings (a crash, a read-gap `skipped=`, cosmetic output) — those are
   worth noting, but FP/FN are the target. A freshly deployed stack with NO
   out-of-band change is the cleanest oracle:
   - **False positive (FP)** — the most user-damaging class. After `record`, a
     `check` MUST be CLEAN. Any `declared`-tier drift on a clean recorded stack
     means cdkrd's declared template value normalizes differently from the live
     value (a normalization / default-folding bug). `record` snapshots only the
     UNDECLARED dimension, so a surviving post-record drift is necessarily a
     declared-dimension FP — exactly the class worth catching. **The invariant
     (see CLAUDE.md / DESIGN.md): a clean, un-mutated deploy must show ZERO
     `[Potential Drift]` on a `check` BEFORE `record`, too.** Every value AWS
     assigns at creation that the template never declared is an initial/default,
     not a divergence — so it MUST fold to `atDefault`. `[Potential Drift]` is only
     ever a REAL divergence (a user change, or an AWS out-of-band change AFTER
     creation like Application Signals adding IAM perms). So `check`-before-`record`
     on a fresh fixture and read the `[Potential Drift]` list: **every entry there
     is a fold gap = a bug** (the FP the check-output note + issue link ask users to
     report). When a candidate default's status is uncertain, **RESOLVE it by
     verifying** what AWS assigns to a fresh minimal config — never leave it
     surfaced as "conservative", that just ships the bug. A value the user never
     changed showing on a first `check` is the bug, not an acceptable state:
     **do NOT rationalize leaving it `undeclared` as "honest", and shrinking the
     count from N to "a few" is not a fix — the target is zero.** Fold by escalating
     through the CLAUDE.md **fold-strategy decision order**, stopping at the first
     that applies: (1) equality-gated constant (`KNOWN_DEFAULTS` /
     `KNOWN_DEFAULT_PATHS`) — folds the default, surfaces a change away (detection
     kept); (2) **derived** default (`CONTEXT_DEFAULTS` = f(region), `ENGINE_DEFAULTS`
     = f(engine), or a value computed from a sibling / declared prop — e.g. an EB
     `MaxSize` default derivable from its `EnvironmentType`) when the default is a
     deterministic function of the declared inputs rather than a constant (detection
     still kept) — **before calling a default "context-dependent, can't fold", ask
     "can I DERIVE it?"**; (3) value-independent ONLY as a last resort, for a default
     AWS moves (platform AMI, versioned URL, GA version) or a per-resource
     identifier / cosmetic value that cannot be pinned or derived (loses detection —
     acceptable only because it is undeclared, so a user who cares declares it).
   - **False negative (FN) / missed detection** — `record`→`check`→CLEAN does NOT
     exercise detection. So ALSO mutate a **declared, MUTABLE** property out of band
     (the "someone changed it in the console" scenario — Lambda `MemorySize`/
     `Timeout`, SQS `VisibilityTimeout`) and assert `check` DETECTS it (exit 1),
     then `revert` restores it, then `check` is CLEAN. Pick a MUTABLE property:
     create-only/immutable ones (Subnet AZ, NAT AllocationId) can't drift.
3. **Check coverage first.** Before building anything, `grep` the existing fixtures
   so you hunt in genuinely-uncovered territory:

   ```bash
   grep -rln "Kinesis\|Dashboard\|Secret\|intelligentTiering\|FunctionUrl" tests/integration/*/app.ts
   ```

   Empty hits = untested = good hunting ground. But a NON-empty hit does **NOT** mean
   the type's undeclared-default scenario is covered: an existing fixture/corpus case
   that **DECLARES** the suspect property never exercises the undeclared-default fold,
   so a first-run FP on that property stays latent under apparent coverage (observed on
   `Events::ApiDestination` `InvocationRateLimitPerSecond` — the pre-existing corpus case
   declared it, hiding the undeclared-300 FP; go-to-k/cdk-real-drift#615). Before skipping a "covered" type,
   check whether any existing case leaves the suspect property **UNDECLARED** — `grep`
   the fixture `app.ts` / the corpus case's `declared` block for it; if every case
   declares it, the undeclared-default path is still open hunting ground.

   **The single most reliable FP-finder: deploy each priority type in its BAREST
   possible config — one type at a time — and `check` immediately (before `record`).**
   A minimal fixture declares only what CFn REQUIRES (e.g. an RDS `DBInstance` with just
   `engine` / `dbInstanceClass` / `allocatedStorage` / master creds — no version, storage,
   or retention) and so leaves the MOST properties undeclared → it exercises the MOST
   default-folds, which is exactly where first-run FPs live. A rich fixture (or a corpus
   case that declares those props) HIDES them. This is the systematic loop that prevents
   the whole class: **minimal deploy → immediate `check` → fold every `[Potential Drift]`
   to zero → move to the next type.** Do not settle for one rich fixture per type.
   **And cover the type's COMMON VARIANTS in their minimal form, not just one** — a
   default is frequently a function of a mode / family / engine, so a variant you did not
   deploy is an unguarded gap. Concretely (a live-found miss, go-to-k/cdk-real-drift#1477): the RDS folds were
   all built from an Aurora / `DBCluster`-centric corpus, so a minimal **non-Aurora
   provisioned `DBInstance`** still first-ran FPs on `StorageType` (`gp2` — folded only
   for `aurora`), `BackupRetentionPeriod` (`1` — added to `DBCluster` but not
   `DBInstance`), and undeclared `EngineVersion`. When a type has engine / mode / family
   axes (RDS provisioned vs Aurora, and per-engine; ElastiCache redis vs valkey vs
   memcached; ECS EC2 vs Fargate; a create-only vs mutable form), enumerate the axis and
   deploy the MINIMAL form of each branch — the corpus being green on ONE variant proves
   nothing about the others.

4. **Probe CC support BEFORE an expensive deploy — skip the CC-gap tail.** For a
   high-cost or slow stateful/niche type (RDS-family, OpenSearch, MSK, Neptune,
   DocumentDB, Cloud Map, …), first check whether Cloud Control can even READ it —
   the FP/FN hunt only has traction on **CC-readable** types (where AWS's live model
   diverges from the template by normalization). If the type's CC read throws
   `UnsupportedActionException`, every resource comes back `skipped=N` (surfaced
   transparently in the `info:` footer — NOT a false negative): a clean `record`→
   `check` is hollow and a detect is invisible because the resource was never read.
   Such a type yields **zero FP/FN bugs** and has **no regression value as a fixture**
   — it is an `SDK_OVERRIDES` reader candidate (a separate feature task), not a hunt
   target. So do NOT burn a paid deploy on it. Confirm support first:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'ProvisioningType'   # FULLY_MUTABLE/IMMUTABLE = provisionable; then probe READ:
   # if you have a live instance, `cloudcontrol get-resource` — UnsupportedActionException = CC-gap
   ```

   (Confirmed CC-gap this way: ServiceDiscovery HttpNamespace+Service, DocumentDB
   DBCluster/DBInstance, AppSync ApiKey/GraphQLSchema — all `SDK_OVERRIDES` candidates,
   not hunt targets.)

   The INVERSE is prime hunting ground: an `SDK_OVERRIDES` reader / `SDK_SUPPLEMENTS`
   entry that EXISTS but has **zero corpus cases and zero fixtures** was added from a
   live FN report without ever exercising the barest first-run path — deploy its
   minimal form first (the 2026-07-12 hunt's RedshiftServerless Workgroup trio, go-to-k/cdk-real-drift#1489,
   came from exactly this audit; ACM Certificate / ELBv2 TrustStore / DAX /
   MediaConvert / SageMaker EndpointConfig / ClientVPN remain unexercised).

   **A `read` handler being present is NOT enough — also check the
   `primaryIdentifier` ARITY.** A type can have a CC `read` handler yet still be
   silently `skipped` with a `ValidationException` (a DIFFERENT read-gap class than
   `UnsupportedActionException`) when its `primaryIdentifier` is COMPOSITE (more than
   one segment) but its CFn physical id is only the CHILD segment — Cloud Control
   `GetResource` then rejects the bare id. This is a `CC_IDENTIFIER_ADAPTERS` fix
   (derive the `parent|child` / `child|parent` composite from the resolved declared
   Ref), NOT an `SDK_OVERRIDES` one. Probe it offline before deploying:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'Schema' --output text | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['primaryIdentifier'])"
   ```

   `primaryIdentifier` length > 1, the type is CC-`read`-able, it is NOT already in
   `CC_IDENTIFIER_ADAPTERS` / `SDK_OVERRIDES`, and the CFn `Ref` returns only the
   child segment → a likely declared-read gap worth a (cheap) deploy to confirm the
   exact composite order (the order is unreliable to guess — verify live, e.g. with
   `aws cloudcontrol get-resource`). Confirmed this way: Logs SubscriptionFilter
   (`FilterName|LogGroupName`, PR go-to-k/cdk-real-drift#344). **But weight by GENERATION: registry-era
   types are overwhelmingly NATURAL composites** (their CFn physical id is already
   the `seg1|seg2` join, so CC reads them as-is — no adapter needed). The 2026-07-14
   ccpi-hunt deployed 7 uncovered composite-pi types in one cheap stack
   (ServiceCatalog PortfolioPrincipalAssociation + TagOptionAssociation, AppRegistry
   AttributeGroupAssociation, aoss AccessPolicy, EC2 SecurityGroupVpcAssociation,
   Lex BotVersion + BotAlias) and ALL read clean — zero `skipped`. The gap class
   lives in LEGACY types that kept a bare-segment physical id when registry-migrated
   (the existing ~40 adapters are all that class); a one-stack association-pack probe
   is still worth it for new suspects, but expect "no gap" as the common outcome.

5. **Predict FP classes from the fold allowlists, then audit them OFFLINE before any
   paid deploy.** The per-type fold tables in `src/normalize/noise.ts` ARE the inventory
   of FP classes already found — and most are CURATED, KNOWN-INCOMPLETE allowlists
   (`CASE_INSENSITIVE_PATHS`, `VERSION_PREFIX_PATHS`, `UNORDERED_ARRAY_PROPS` /
   `UNORDERED_OBJECT_ARRAY_PROPS` / `UNORDERED_NESTED_OBJECT_ARRAY_PATHS`,
   `RATE_EXPRESSION_PATHS`, `EPOCH_HOUR_PATHS`, `TRAILING_DOT_PATHS`). Each lists only
   the 1–2 types someone already hit; **any OTHER type sharing that semantic divergence
   is an unguarded gap.** So you can PREDICT where FPs hide instead of deploying blind:
   - The recurring FP-generating axes (AWS live value ≡ declared value but ≢ structurally):
     **set-like array reorder** (DNS RecordSet values, Cognito URL/OAuth lists, WAF
     sets, SG rules), **partial→concrete version** (`*Version`/`EngineVersion`/
     `KafkaVersion` a service expands), **case-insensitive enum** (`*Type`/`*Protocol`/
     `*Status`), **trailing/format normalization** (FQDN dot, ARN `:*`, rate(), epoch),
     **object↔JSON-string shape** (a `Definition`/`Content`/policy declared as object,
     read back as string). Suspect any prop named `*Version`/`*Type`/`*Protocol`/
     `*Status`/trailing-`Name`(FQDN)/`*Arn`/`Schedule*`/map-type/order-insensitive array.
   - **Audit the gap OFFLINE first (free).** For each candidate, read the allowlist to
     see what's covered, then grep `tests/corpus/*.json`: compare `resource.declared` vs
     `liveRaw` for the prop. If a recorded live read EXHIBITS the divergence and
     `expected` is clean → the trigger is already covered+guarded (`corpus-replay` proves
     it), skip it. If no corpus case exercises the trigger (e.g. a RecordSet case with
     only ONE value never tests multi-value reorder), or the service can't even produce
     the divergence (MSK rejects a partial version → declared==live, NO risk) → that
     determination is the deliverable. Only deploy the genuine, reproducible gaps. This
     ruled out a whole class and ~10 wasteful deploys in the PR go-to-k/cdk-real-drift#303 hunt — fan out
     parallel read-only agents (one per class) to do the audit. The fix for a confirmed
     gap is usually a one-line allowlist addition + the unit test + corpus case.
6. **Parallelize, but cap at 3–4 stacks.** Independent stacks (unique names) can
   deploy concurrently as background tasks, but more is not better — it makes logs
   and teardown hard to follow. VPC/NAT (~3 min) pace a wave; most others ~1–2 min.

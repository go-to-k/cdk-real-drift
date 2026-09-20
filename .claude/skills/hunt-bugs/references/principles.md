<!-- Part of the /hunt-bugs skill. Posture, goal, core principles. READ IN FULL at stage entry. -->

## Default posture: assume many latent bugs remain — sweep wide, ~5 rounds

The fold/normalize tables are known-incomplete allowlists, so unless the user scopes
it down:

- **Do ~5 rounds**, each a fresh angle on fresh common-but-untested types/configs. A
  clean round means change the angle, not stop early.
- **Vary the lens every round**: first-run undeclared FP (fold gaps), declared-tier
  normalization FP, missed-detection FN, write-only / read-gap FN, revert
  non-convergence, composite-identifier read skips, offline corpus mining. Menu = the
  principles below + `references/gotchas.md`.
- **Parallelize within the 3–4 stack cap**, with unique stack names so concurrent
  sessions never collide. VPC/NAT (~3 min) paces a wave; most others ~1–2 min.

## Goal: filing issues vs. fixing — ASK at run time unless told

A hunt can stop at **filing GitHub issues** or go through **fix + PR + merge** — very
different in cost, blast radius and collision risk. **Unless the user stated the goal,
ASK at the start of the run.** Issue-only = investigate, live-verify, harvest corpus,
file well-scoped issues (repro + recommended fix), do NOT change `src/`. Fix + PR =
additionally root-cause, fix, add the unit test, keep the fixture, carry through PR.

## Core principles

1. **Many-people-hit beats niche.** Prioritize what most CDK users deploy daily — S3,
   Lambda, VPC, DynamoDB, IAM, API Gateway, ECS/Fargate, RDS, SQS/SNS, CloudFront.

2. **The two signals ARE the priority — hunt FP and FN above all else.** Incidental
   findings (a crash, a read-gap `skipped=`, cosmetic output) are worth noting but are
   not the target.
   - **False positive (FP)** — most user-damaging. **Invariant (AGENTS.md /
     DESIGN.md): a clean, un-mutated deploy shows ZERO `[Potential Drift]` even on a
     `check` BEFORE `record`.** An undeclared creation-time value is a default and
     MUST fold to `atDefault`; `[Potential Drift]` means REAL divergence only (a
     change AFTER creation). On a fresh fixture **every entry = fold gap = bug**.
     Never ship one as "conservative" or rationalize `undeclared` as "honest";
     N→"a few" is not a fix — target zero.
   - **Fold-strategy decision order** (first match wins, per AGENTS.md): (1)
     equality-gated constant (`KNOWN_DEFAULTS` / `KNOWN_DEFAULT_PATHS`) — detection
     kept; (2) **derived** default (`CONTEXT_DEFAULTS` = f(region), `ENGINE_DEFAULTS`
     = f(engine), or f(a declared sibling prop)) when deterministic in declared
     inputs, detection kept — ask "can I DERIVE it?" before calling a default
     "context-dependent, can't fold"; (3) value-independent ONLY as a last resort (a
     default AWS moves, or an unpinnable per-resource identifier), which loses
     detection.
   - **False negative (FN)** — `record`→`check`→CLEAN does NOT exercise detection.
     ALSO mutate a **declared, MUTABLE** prop out of band (the console-change
     scenario), assert `check` DETECTS it (exit 1), `revert` restores, `check` CLEAN.
     Create-only/immutable props can't drift — pick a mutable one.

3. **Check coverage first, and read what the coverage actually exercises.**

   ```bash
   grep -rln "Kinesis\|Dashboard\|Secret\|intelligentTiering\|FunctionUrl" tests/integration/*/app.ts
   ```

   Empty hits = untested = good ground. A NON-empty hit does **NOT** cover the
   undeclared-default scenario: a case that DECLARES the suspect prop never exercises
   the undeclared fold, so a first-run FP stays latent under apparent coverage
   (go-to-k/cdk-real-drift#615). Before skipping a "covered" type, grep its fixture
   `app.ts` / corpus `declared` block — if every case declares it, the path is open.

4. **The single most reliable FP-finder: deploy each priority type in its BAREST
   config — one type at a time — and `check` immediately, before `record`.** Declaring
   only what CFn REQUIRES leaves the most props undeclared, so the most default-folds
   are exercised; a rich fixture HIDES them. Loop: minimal deploy → immediate `check`
   → fold every `[Potential Drift]` to zero → next type.
   **Cover the COMMON VARIANTS minimally too** — a default is often f(mode / family /
   engine), so an undeployed variant is an unguarded gap
   (go-to-k/cdk-real-drift#1477). Enumerate the axes and deploy each branch's MINIMAL
   form: green on ONE variant proves nothing about the others.

5. **Probe CC support BEFORE an expensive deploy.** The hunt only has traction on
   **CC-readable** types. `UnsupportedActionException` on read → every resource
   `skipped=N` (shown in the `info:` footer, NOT a false negative), so a clean
   `record`→`check` is hollow and the deploy yields nothing; such a type is an
   `SDK_OVERRIDES` reader candidate, a separate feature task. Confirm first with
   `aws cloudformation describe-type --type RESOURCE --type-name <T> --query
ProvisioningType`, then probe READ with `cloudcontrol get-resource` on a live instance.

   **A `read` handler is NOT enough — also check `primaryIdentifier` ARITY.** A
   COMPOSITE `primaryIdentifier` whose CFn physical id is only the CHILD segment makes
   `GetResource` reject the bare id → silently `skipped` with `ValidationException`, a
   DIFFERENT read-gap class whose fix is `CC_IDENTIFIER_ADAPTERS` (derive the
   composite from the resolved declared Ref), NOT `SDK_OVERRIDES`. Read the arity out
   of the schema offline and verify the composite ORDER live rather than guessing
   (go-to-k/cdk-real-drift#344). Registry-era types are overwhelmingly NATURAL
   composites that read as-is; the gap class lives in LEGACY types that kept a
   bare-segment physical id when registry-migrated.

   The INVERSE is prime ground: an `SDK_OVERRIDES` / `SDK_SUPPLEMENTS` entry with zero
   corpus cases and zero fixtures has never exercised its barest first-run path.

6. **Predict FP classes from the fold allowlists, then audit them OFFLINE before any
   paid deploy.** The per-type tables in `src/normalize/noise.ts`
   (`CASE_INSENSITIVE_PATHS`, `VERSION_PREFIX_PATHS`, `UNORDERED_*`,
   `RATE_EXPRESSION_PATHS`, `EPOCH_HOUR_PATHS`, `TRAILING_DOT_PATHS`) each list only
   the 1–2 types someone already hit; **any OTHER type sharing that semantic
   divergence is an unguarded gap.** Recurring axes (live ≡ declared but ≢
   structurally): set-like array reorder, partial→concrete version, case-insensitive
   enum, trailing/format normalization (FQDN dot, ARN `:*`, `rate()`, epoch), and
   object↔JSON-string shape — so suspect any `*Version` / `*Type` / `*Protocol` /
   `*Status` / `*Arn` / `Schedule*` prop, an FQDN-ish `*Name`, a map type, or an
   order-insensitive array.

   **Audit the gap OFFLINE first (free).** Per candidate: read the allowlist, then
   grep `tests/corpus/*.json` comparing `resource.declared` vs `liveRaw`. A recorded
   live read that EXHIBITS the divergence with a clean `expected` is already covered —
   skip it. If no corpus case exercises the trigger, or the service cannot produce the
   divergence, that determination IS the deliverable. Only deploy genuine, reproducible
   gaps (go-to-k/cdk-real-drift#303). Fan out parallel read-only agents, one per class;
   a confirmed gap's fix is usually a one-line allowlist addition + unit test + corpus
   case.

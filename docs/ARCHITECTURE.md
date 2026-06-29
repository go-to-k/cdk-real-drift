# cdk-real-drift (`cdkrd`) — full architecture & design review

> Audience: a reviewer doing a **spec + design review** before the Phase 4 public
> launch. This document is the single self-contained map of the whole tool: what it
> is, every moving part, the design decisions and their rationale, the current
> state, and the open questions worth challenging. It is accurate to the code after
> the design-review fix pass (R1–R34 applied; 250+ unit tests green, build clean —
> run `vp run test` for the current count).
> Companion docs:
> [DESIGN.md](../DESIGN.md) (terse design), [redesign-notes.md](redesign-notes.md)
> (pre-publication decisions), [README.md](../README.md) (end-user).

---

## 1. What it is (and is not)

`cdkrd` detects — and reverts — drift between your **real deployed AWS resources**
and your **AWS CDK** intent, **including properties you never declared** in
the (synthesized CloudFormation) template. That undeclared-property dimension is the differentiator: `cdk drift`,
CloudFormation drift detection, `driftctl`, and `terraform plan` all compare only
properties that appear in the template, so a change to a setting you never declared
(a bucket's `OwnershipControls`, a role's `PermissionsBoundary`, encryption toggled
off, an extra inline policy, transfer acceleration enabled out-of-band) is invisible
to them. (`terraform plan` comes closest — its refresh notice surfaces some
undeclared-attribute changes — but the notice carries no exit-code signal, the next
`apply` silently absorbs the change into state, and undeclared sub-resources are
never read at all; see [why-a-baseline-file.md §8](why-a-baseline-file.md#8-prior-art-what-terraform-plan-actually-does-here).)
`cdkrd` reads the **full** live resource model and reports the divergence.

- **Reality vs intent**, not code vs template. It deliberately does NOT reimplement
  `cdk diff` (which is code-vs-deployed-template). It is a drift tool.
- **No AWS Config dependency** (Config is off in many accounts; cost + setup).
- **CDK-only**: it always resolves the CDK app (synth via `@aws-cdk/toolkit-lib`, or
  a pre-synthesized `cdk.out`) to discover which stacks exist + label by construct
  path. The drift _comparison_ itself is CloudFormation-generic — it reads each
  stack's deployed template + live state from AWS — but cdkrd operates only on stacks
  the app defines (there is no arbitrary-deployed-stack-by-name mode; R33).

## 1a. The core thesis & the bets to validate (read this first)

**The problem.** Infrastructure drifts. Someone clicks the console, a script runs, an
incident gets a hot-fix — and the real resource no longer matches the IaC. Every
existing drift tool (`cdk drift`, CloudFormation drift detection, `driftctl`,
`terraform plan` — §1 notes terraform's partial exception) answers only "do the
properties I _declared_ still match?" But the
most dangerous drift is often in properties you never declared at all — security
posture (public-access blocks, encryption, ownership controls, permission
boundaries, extra inline policies) lives in defaults you never wrote down, so when it
changes, no tool tells you. **The thesis of `cdkrd`: the declared/undeclared
boundary is the wrong place to stop looking, and the gap is exactly where the
security-relevant drift hides.**

**The approach.** Read the _full_ live model of each resource (not just the declared
subset), and report everything that diverges — then make the noise tractable by
_subtracting_ what's explainable (the template, the resource schema, AWS-managed
fields, canonicalization) rather than by maintaining a hand-curated allow-list of
"things worth watching." Give the result a baseline you record and commit to git, so
"what undeclared state we record" becomes a reviewable artifact, and let the user
`revert` the rest.

**The bets a reviewer should pressure-test** (is this the right approach?):

1. **Subtractive > additive noise control.** We bet that snapshot-everything-minus-
   explainable converges to a small, meaningful signal, and that a watch-list would
   instead explode and rot. Evidence: PoC + 8-fixture dogfood reduced undeclared
   noise to single digits of real signal. Risk: long-tail resource types whose
   "explainable" defaults aren't in any schema → residual noise. _Is the subtractive
   model sound, or will the residual grow unbounded across the full AWS surface?_
2. **Fail-closed beats best-effort.** We never fabricate a value to compare; if an
   intrinsic or a schema gap makes a property unknowable, we mark it `unresolved`/
   `skipped` and exclude it from the pass/fail signal. This trades coverage for
   zero false positives. _Is "never cry wolf" the right default for a drift tool, or
   should it surface uncertain cases louder?_
3. **Cloud Control API as the universal reader.** CC API auto-covers new resource
   types without per-type code; SDK overrides fill only the gaps. _Does CC API's
   coverage + model fidelity hold up across the breadth users will throw at it, or
   does the SDK-override list grow until the "generic" claim breaks?_ **Tracking
   (as of the R85 pass):** `SDK_OVERRIDES` holds 14 types, 13 genuine CC-API gaps
   (`UnsupportedActionException` / `ValidationException` from GetResource — plus
   Scheduler::Schedule, whose CC read handler only finds schedules in the DEFAULT
   group) and one read-ENRICH override (Cognito::IdentityPool, which CC reads fine
   for every base property but cannot return its writeOnly `CognitoEvents` Sync
   trigger — so the override reads the base via CC and only enriches that one field),
   surfaced across 2 real-app dogfoods + 10 integ fixtures. The bet holds
   while the count grows only a few types per new dogfood; revisit it if a single
   new stack adds many overrides at once (= the generic claim is breaking). A
   second, smaller gap class is CC IDENTIFIERS: some types' CFn physical id is not
   the CC primaryIdentifier (AppSync GraphQLApi ARN vs ApiId; and the
   `${parent}|${child}` composites — Cognito UserPoolClient, ApiGatewayV2
   Stage/Route/Integration (R76), AppConfig Environment/ConfigurationProfile (R77)
   — all built by the shared `compositeWith(parentKey)` helper; plus
   ApplicationAutoScaling ScalingPolicy (R79), whose `${PolicyARN}|${dimension}`
   identifier needs the ScalableDimension parsed out of the resolved
   ScalingTargetId; plus ECS Service (R102), whose `[ServiceArn, Cluster]`
   composite is the SERVICE arn FIRST then the cluster (`${physicalId}|${Cluster}`
   — the inverse of `compositeWith`'s parent-first order); plus the ApiGateway v1
   parent-first `[RestApiId, <child>]` (Model/RequestValidator/Resource/Stage) and
   Cognito `[UserPoolId, <child>]`
   (UserPoolDomain/UserPoolResourceServer/UserPoolUser) composites,
   and the CHILD-first `[<child>, RestApiId]` (`${physicalId}|${RestApiId}`) cases
   ApiGateway::Deployment (R129) and ApiGateway::DocumentationPart — all verified
   live (skipped 7→0; DocumentationPart found by the cognito/apigw-rest-subres hunt);
   note
   ApiGateway::Method needs NO adapter, its CFn physical id is already the full
   `RestApiId|ResourceId|HttpMethod`; plus
   EC2::TransitGatewayRouteTablePropagation, whose `[TransitGatewayRouteTableId,
TransitGatewayAttachmentId]` composite is built from TWO declared props (its
   CFn Ref is the underscore `attach_rtb` console id, not the CC pipe composite
   — the sibling RouteTableAssociation/Route Refs ARE already the pipe composite,
   so they need no adapter) — `CC_IDENTIFIER_ADAPTERS`
   in router.ts maps those without leaving the CC read path, which is strictly
   cheaper than an SDK override (no new dependency, no projection). The same adapter
   resolves the revert UpdateResource identifier (stack-actions.ts), not just the
   read. Prefer an adapter over an override whenever the only gap is the identifier
   shape.
4. **The deployed template, not synth, is the declared baseline.** So un-deployed
   code edits never masquerade as drift; `--pre-deploy` is the opt-in inversion.
   _Right call, or do users actually expect code-vs-reality by default?_
5. **Git-committed baseline as the undeclared contract.** Undeclared "drift" is only
   drift relative to a human-recorded snapshot — the full rationale (why the state
   must exist, and why neither schema defaults nor `config.json` can replace it)
   is [why-a-baseline-file.md](why-a-baseline-file.md). _Is a committed file the
   right control surface, or does it become a rubber-stamp that hides real change?_
6. **Revert via the same generic CC write path** (UpdateResource) + thin SDK writers,
   not a per-type provider fleet. _Is generic revert safe/complete enough, or are the
   not-revertable gaps (toggle props, add/remove-statement types) too sharp an edge?_
   One sharp edge is closed (R102): Cloud Control applies the patch read-modify-write,
   and read handlers cannot return write-only properties, so a minimal patch dropped
   them (cdkd #812 — reverting any prop on an ECS Service with a managed EBS volume
   lost the write-only `VolumeConfigurations` and UpdateService hard-failed). The
   revert now re-includes every fully-resolved declared write-only top-level prop the
   patch does not already touch (`writeOnlyReincludeOps` in plan.ts).

If these six bets are right, the tool is right. The rest of this document is how each
is realized in code.

## 2. The three-verb model

Detect-only is not the identity. After `check`, you decide what each finding
means, and the verbs mirror the choice (see [redesign-notes.md](redesign-notes.md)
Decision 1):

| verb           | meaning                                                            | writes              |
| -------------- | ------------------------------------------------------------------ | ------------------- |
| `cdkrd check`  | find drift (declared vs deployed template, undeclared vs baseline) | nothing             |
| `cdkrd record` | "this undeclared state is the norm" — snapshot it; KEEP watching   | git file (baseline) |
| `cdkrd ignore` | "stop reporting this property" (declared or undeclared); STOP      | git file (config)   |
| `cdkrd revert` | "current state is WRONG" — write the desired value back to AWS     | AWS (confirmed)     |

`record` (undeclared properties **and** out-of-band `added` resources, keeps
watching: a later change to the snapshotted value/resource re-surfaces as drift)
and `ignore` (declared, undeclared, OR added, stops watching: re-tags the finding
`ignored` forever) are the two non-AWS resolutions; `ignore` is the only in-tool
way to accept a **declared** drift. The `record` baseline
lives per stack/account/region; the `ignore` rules live once, app-wide, in
`.cdkrd/config.json` (`config/config-file.ts` — `addIgnoreRules` writes,
`applyIgnores` reads).

In a TTY, `check` offers to resolve the drift **inline** (R28, extended R121/R125):
after reporting it prompts `Nothing / Record / Revert / Ignore / Decide
per finding` (Nothing is FIRST so the safe no-op is the default cursor; each bulk
option shown only when ≥1 finding can take it; "Decide per finding" only when >1
finding is decidable). A cancelled sub-prompt (Esc) returns to this menu (R125). The bulk options apply one
action to applicable findings (each leads to that verb's own multiselect, which
narrows WHICH findings — revert starts fully unselected, R137);
"Decide per finding" opens the per-finding **action picker**
([action-picker.ts](../src/commands/action-picker.ts) — `↑↓` move, `space` cycle
the focused row's applicable actions, `→` set every row to the focused action,
`enter` apply). Every path branches into the SAME per-stack code as the standalone verbs
(`recordStack` / `ignoreStack` / `revertStack` in
[stack-actions.ts](../src/commands/stack-actions.ts), driven by
[interactive-resolve.ts](../src/commands/interactive-resolve.ts)), so the interactive
flow and `cdkrd record/ignore/revert` can never diverge — the per-finding path passes
each verb the chosen subset (`preselectedKeys` for record, a findings filter +
`autoSelectAll` for revert) so the verb skips its own selection prompt but keeps its
AWS-write confirm. Default is `Nothing` (plain-check behaviour); skipped under
`--json` / `--show-all` / `--pre-deploy` / `--fail` / non-TTY. Aborting the Revert
confirmation keeps the pre-revert drift state — no AWS write happened, so the
drift still stands and stays reported (symmetric with `Nothing`); `revertStack`
signals this via `RevertOutcome.aborted` so the standalone `revert` command keeps
its own exit-0-on-abort behaviour (R30).

Flags (all parsed in [src/cli-args.ts](../src/cli-args.ts)): `--region` (no silent
default — resolves via SDK chain, errors if absent), `--profile`, `-a/--app <cmd|cdk.out>`
(+ `$CDKRD_APP` / cdk.json `"app"`), `-c/--context key=value` (repeatable),
`--json`, `--fail` (check: exit 1 on drift + never prompt — automation mode, R53),
`--show-all` (inventory mode:
ignore baseline, show ALL undeclared), `--pre-deploy` (check vs local synth template),
`--undeclared-only` / `--declared-only` (scope to one tier — R59; at most one scope flag),
`--dry-run` (revert preview), `--yes/-y`. With no stack arg, every stack the app
defines is targeted; a stack arg selects by exact name or glob (`cdkrd check 'Dev*'`).
The known-flag set is closed: an unknown option or a value flag missing its
value is a fail-fast **exit 2** error, so a typo'd flag never silently becomes
a stack name (R36).

Exit codes: `0` clean · `1` drift detected · `2` error.

## 3. The `check` pipeline

Entry: [src/commands/check.ts](../src/commands/check.ts) → shared gather in
[src/commands/gather.ts](../src/commands/gather.ts).

```
1. resolve stacks        resolve-stacks.ts: synth-discover the app → all | exact names | globs
2. desired (declared)    template-adapter.ts: GetTemplate + DescribeStackResources
                         (phys-id map) + DescribeStacks (params) → intrinsic resolution
                         (--pre-deploy: LOCAL synth template replaces GetTemplate;
                         otherwise the synth template recovers GetTemplate's `?`-masked
                         non-ASCII literals — recover-nonascii.ts, mask-gated per leaf)
3. live full state       read/router.ts: Custom:: → skip (no API call); SDK override
                         (gap types) FIRST, else CC API GetResource; not-found →
                         deleted; unreadable → skipped
   --- PASS 1:   read ALL resources (bounded pool), populate ResolverContext.liveAttrs
   --- RESOLVE:  re-resolve EVERY resource's declared (GetAtt now resolvable)
   --- PASS 1.5: re-read override resources that pass 1 skipped as "target not
                 resolvable" but whose declared target now resolves (e.g. Lambda
                 Permission.FunctionName = GetAtt[fn, Arn]) — concurrent, once
   --- PASS 1.6: added-resource enumeration — for each declared PARENT type with a
                 CHILD_ENUMERATORS entry (read/child-enumerators.ts), list its LIVE
                 child resources via the service SDK and emit an `added` finding for
                 any not in the template (e.g. an API Gateway Method on `/`). Each
                 added child is then read in FULL (CC GetResource) + normalized
                 (normalizeLiveModel) so `record` can snapshot it and a later change
                 surfaces as drift. An enumeration failure is surfaced as a `skipped`
                 finding on the parent
   --- PASS 2:   classify
4. normalize / subtract  classify.ts orchestrates the normalizers (section 6)
5. classify (tier)       deleted | added | declared | undeclared | atDefault | generated | readGap | unresolved | skipped
                         (added = a whole LIVE child resource not in the template,
                         from pass 1.6's enumerators — resource-granularity sibling of
                         undeclared, reconciled against the baseline the same way:
                         recorded+unchanged is suppressed, recorded+changed is drift,
                         an UNRECORDED added resource is Not-Recorded inventory (not
                         drift). Revertable by CC DeleteResource; PR4)
                         (atDefault = undeclared but EQUAL to a known AWS default —
                         folded, never drift, never recorded; R86)
                         (generated = undeclared (absent from the template) but EQUAL to the
                         identifier AWS auto-assigns for THIS resource at deploy — its minted
                         physical name, or a default LoggingConfig log group derived from the
                         physical id. NOT "CDK generated it into the template" — that would be
                         declared; this tier is precisely the values your template never set;
                         folded like atDefault, never drift, never recorded; R104)
                         (undeclared also carries a nested:true flag for a live
                         sub-key inside a declared object the template never set; R96)
6. baseline filter       applyBaseline(): undeclared findings already recorded → drop;
                         atDefault AND generated reconciled too (an UNCHANGED recorded
                         value now at-default/generated is suppressed, not a false
                         "removed since record") — but a recorded value CHANGED to a
                         default/generated form (e.g. reset out of band) is real drift;
                         a SKIPPED resource's recorded values are unread, not "removed"
7. report + exit code    report.ts: drift tiers in full + info: footer (1 line;
                         1 bullet/tier when 2+; --verbose expands, --show-all expands
                         atDefault + nested undeclared); --json carries all findings;
                         worst exit across stacks
```

The two-pass structure (PR "resolve Fn::GetAtt against live attributes") is what
lets a declared `Fn::GetAtt(Role, Arn)` resolve to the referenced role's _real_
live ARN instead of falling to `unresolved` — see section 5. **Declared-dependent
SDK override readers retry after GetAtt resolution** (pass 1.5): a reader keyed off
a declared prop that is `Fn::GetAtt` (e.g. `AWS::Lambda::Permission.FunctionName =
GetAtt[fn, Arn]`) cannot run in pass 1 (the target's live attributes are still being
collected), so it would wrongly skip as "target not resolvable"; those resources are
re-read once, concurrently, after the resolve step, so Permission drift is actually
checked.

## 4. Module map (`src/`)

- **cli.ts** — entry; dispatch check/record/ignore/revert (+ help/version).
  **cli-args.ts** — zero-dep arg parser → `CommonArgs`.
- **commands/**
  - **check.ts / record.ts / ignore.ts / revert.ts** — the four verbs.
  - **stack-actions.ts** — the per-stack record/ignore/revert actions shared by the
    standalone verbs and check's interactive prompt (`recordStack` / `ignoreStack` /
    `revertStack`), so they can never diverge.
  - **interactive-resolve.ts** — check's after-report resolution (R28/R121/R125): the
    top-level select (Nothing first as the safe default, then Record / Revert /
    Ignore / Decide per finding) looped so a cancelled sub-prompt returns to the
    menu (Esc = back), and the per-finding dispatch into the stack actions; returns the
    re-evaluated exit code.
  - **action-picker.ts** — the per-finding action picker (R121), built on `@clack/core`'s
    base `Prompt` to bind `↑↓` / `space` (cycle) / `→` (all to focused) / `enter`.
    `applicableActions` / `cycleAction` / `setAllToAction` / `groupByAction` are pure +
    unit-tested.
  - **gather.ts** — shared read+classify pipeline (the 2-pass GetAtt resolution lives here).
  - **resolve-stacks.ts** — synth-discover the app, then turn args into `{stackName, region}[]` (all / exact / glob).
  - **glob-match.ts** — pure `*`/`?` matcher (`isGlob` / `globToRegExp` / `matchesGlob`).
  - **bulk-multiselect.ts** — the record/revert multiselect, built on `@clack/core`'s `MultiSelectPrompt` so it can bind bulk keys the high-level wrapper hides (space = toggle, → = all, ← = none, enter = confirm; mirrors cdk-local's target picker, R116). `bulkSelectValues` / `bulkSelectHint` are pure + unit-tested.
- **desired/** — the "intent" side
  - **template-adapter.ts** — `loadDesired()`: deployed (or `--pre-deploy` synth) template + phys-ids + params → resolved `DesiredResource[]`. Builds `ResolverContext`.
  - **yaml-cfn.ts** — CFn-flavored YAML/JSON template parser.
- **read/** — the "reality" side
  - **router.ts** — `readLive()`: SDK_OVERRIDES first, else CC API GetResource (with `CC_IDENTIFIER_ADAPTERS` deriving the CC identifier when the CFn physical id is not it — AppSync GraphQLApi ARN→ApiId, Cognito UserPoolClient `UserPoolId|ClientId`, Batch JobDefinition ARN→bare name with the `:<revision>` suffix stripped); classifies skip reasons. After a SUCCESSFUL CC read, an optional `SDK_SUPPLEMENTS[type]` reader runs and shallow-merges a few EXTRA top-level fields onto the CC model — for a type CC reads fine EXCEPT for a writeOnly-but-SDK-readable prop CC never echoes (`AWS::SSM::Parameter` `Description`/`AllowedPattern`/`Tier` via `ssm:DescribeParameters` — a console edit to the description was otherwise silently invisible; Tier folds an undeclared `"Standard"` default via KNOWN_DEFAULTS and a declared `"Intelligent-Tiering"`→Standard/Advanced resolution via `INTELLIGENT_TIERING_PATHS`, and a Tier upgrade is detect-only since AWS forbids an advanced→standard downgrade via update [`notRevertable` in plan.ts]; `AWS::ElastiCache::ReplicationGroup` `PreferredMaintenanceWindow`/`NotificationTopicArn`/`EngineVersion`, which are writeOnly on the RG and live on its MEMBER cache clusters, read verbatim via `elasticache:DescribeReplicationGroups`→`DescribeCacheClusters` — EngineVersion folds the `7.1`→`7.1.0` prefix via `VERSION_PREFIX_PATHS`; `AWS::ECS::Service` `ServiceConnectConfiguration` + `VolumeConfigurations` (managed EBS volumes), both writeOnly and living on the service's deployments, reconstructed from the PRIMARY deployment via `ecs:DescribeServices` — PascalCased to the CFn shape, with the AWS-defaulted `DiscoveryName`==`PortName` / `FilesystemType`=="xfs" dropped, and the declared ServiceConnect namespace `Fn::GetAtt` now resolves because `SDK_OVERRIDES` reads the Cloud Map `PrivateDnsNamespace`/`PublicDnsNamespace` Arn into `liveAttrs` (the EBS `RoleArn` GetAtt resolves off the CC-readable IAM role). Both revert via one `ecs:UpdateService` `SDK_NESTED_WRITERS` writer that re-supplies the WHOLE declared prop(s) the ops touch (camelCased back from PascalCase) — Cloud Control cannot sub-path patch a writeOnly prop, and `ctx.declared` carries the whole config so any nested drift converges). Unlike an override (which REPLACES the CC read), a supplement adds to it; a supplement failure is non-fatal (keep the CC model). The supplemented props are exempted from the writeOnly strip via `OVERRIDE_READABLE_WRITEONLY` so they are compared, not readGap'd. (Evaluated and DEFERRED: `AWS::Cognito::UserPool` `EnabledMfas` — `GetUserPoolMfaConfig` keeps returning the `SmsMfaConfiguration` block after SMS is disabled, so it cannot be reliably reconstructed without FP/FN risk.)
  - **overrides.ts** — `SDK_OVERRIDES` readers for CC-gap types (S3/SNS/SQS BucketPolicy/TopicPolicy/QueuePolicy, IAM Policy/ManagedPolicy, Lambda Permission (the live policy statement is matched by `Sid` = the CFn physical id FIRST, falling back to Action+Principal — so two permissions that share Action+Principal but differ only in SourceArn, e.g. a CDK API Gateway method's deployment-stage vs `test-invoke-stage` permission, are not cross-matched into a false declared drift; incl. the security-scoping conditions PrincipalOrgID + FunctionUrlAuthType so an out-of-band invoke-widening is not invisible), Budgets, **EC2 EIP** via DescribeAddresses, **EC2 LaunchTemplate** via DescribeLaunchTemplateVersions (the `$Default` version's `LaunchTemplateData` — writeOnly in the registry schema, so CC returns only ids/version numbers and the data was a permanent readGap; EC2 returns the data FAITHFULLY with no default injection, so the projection is essentially a pass-through, and `schema-strip.ts` exempts `LaunchTemplateData` from the writeOnly strip via `OVERRIDE_READABLE_WRITEONLY` so the projected value is actually compared — a new default version published out of band with a changed InstanceType/block device/metadata option now surfaces as declared drift; VersionDescription + the top-level resource TagSpecifications stay writeOnly readGaps), **Route53 RecordSet** via ListResourceRecordSets (disambiguated by SetIdentifier so a weighted/latency/failover/geo variant is matched to its OWN record, not whichever shares the name+type first, and projecting the routing fields Weight/Region/Failover/GeoLocation/MultiValueAnswer/HealthCheckId + GeoProximityLocation/CidrRoutingConfig [the geoproximity Bias=0 default folds via KNOWN_DEFAULT_PATHS]; revertable via a ChangeResourceRecordSets UPSERT SDK writer that rebuilds the desired RRSet from the projection), **Glue Table** via GetTable (revertable via an UpdateTable SDK writer — sibling of the Glue Job writer; the reader returns the full CFn TableInput so the overwrite is safe), **Glue Classifier** via GetClassifier (the whole Glue family is a CC read gap — GetResource throws UnsupportedActionException; the live `Classifier` is a one-of union {CsvClassifier|GrokClassifier|JsonClassifier|XMLClassifier} mirroring the CFn shape — project the present member, dropping AWS-managed Version/CreationTime/LastUpdated + the non-CFn CsvClassifier `Serde` field [GetClassifier returns "None" by default but CFn cannot declare it]; revertable via an UpdateClassifier whole-member overwrite SDK writer that requires a Name), **Glue Workflow** via GetWorkflow (NON_PROVISIONABLE CC read gap; projecting Name/Description/DefaultRunProperties/MaxConcurrentRuns, dropping the AWS-managed run/graph state CreatedOn/LastModifiedOn/LastRun/Graph + Tags; revertable via an UpdateWorkflow SDK writer — UpdateWorkflow is a whole-object overwrite so the writer re-sends the full live model [the reader returns it] and never wipes the un-reverted Description/DefaultRunProperties), **Glue Connection** via GetConnection (NON_PROVISIONABLE CC read gap; HidePassword:true so NO credential enters the baseline; projecting the CFn `ConnectionInput` shape [ConnectionType/Description/MatchCriteria/ConnectionProperties/PhysicalConnectionRequirements/AuthenticationConfiguration/Name], dropping AWS-managed status/timestamps + any `*PASSWORD` ConnectionProperties key [SECRET_ID is KEPT — a Secrets Manager ARN, config not a secret]. READ-ONLY [no SDK writer]: a revert that omitted an un-read credential could clear a JDBC password, so it is deferred. A NETWORK connection's required AvailabilityZone must resolve concretely [env-bound stack] or the whole ConnectionInput is `unresolved`), **Logs MetricFilter** via DescribeMetricFilters (revertable via a PutMetricFilter upsert SDK writer), **Scheduler Schedule** via GetSchedule — CC only reads the default group, **AppSync ApiKey** via ListApiKeys (CC read gap — GetResource UnsupportedActionException, NON_PROVISIONABLE; the CFn physical id is the ARN `apis/<apiId>/apikeys/<keyId>` so both ids are parsed from it; projects ApiId/Description/Expires — Description omitted when empty, and Expires folds via the per-type epoch-hour equivalence [EPOCH_HOUR_PATHS] since AWS rounds it DOWN to the hour. The sibling AWS::AppSync::GraphQLSchema stays `skipped` — the declared schema is a large blob fragile to diff, deferred), **ServiceDiscovery (Cloud Map) HttpNamespace** via GetNamespace + **Service** via GetService (the whole ServiceDiscovery family is a CC read gap — GetResource throws UnsupportedActionException; projecting Name/Description for the namespace and Name/Description/NamespaceId/Type/DnsConfig/HealthCheck\* for the service; an HTTP/API-only service is immutable so only the namespace's Description is revertable, via the UpdateHttpNamespace SDK writer), **DocumentDB DBCluster** via DescribeDBClusters + **DBInstance** via DescribeDBInstances (the whole DocDB family is a CC read gap — GetResource throws UnsupportedActionException; projecting the CFn-modeled scalar props with SDK→CFn name mapping [EnabledCloudwatchLogsExports→EnableCloudwatchLogsExports, DBClusterParameterGroup→DBClusterParameterGroupName, VpcSecurityGroups[].VpcSecurityGroupId→VpcSecurityGroupIds, PerformanceInsightsEnabled→EnablePerformanceInsights]; AvailabilityZones/AvailabilityZone are create-only and NOT projected to avoid a reorder FP; the cluster's mutable BackupRetentionPeriod is revertable via a ModifyDBCluster SDK writer with a safe-to-modify allowlist that excludes EngineVersion so a revert never triggers an engine upgrade; the sibling DBInstance is likewise revertable via a ModifyDBInstance SDK writer (DBInstanceClass/AutoMinorVersionUpgrade/PreferredMaintenanceWindow/CACertificateIdentifier/EnablePerformanceInsights allowlist, DBClusterIdentifier excluded as create-only)), **CodeBuild Project** via BatchGetProjects with a camelCase→CFn-PascalCase projection, R85 — incl. Visibility/VpcConfig/ConcurrentBuildLimit/SourceVersion/LogsConfig/BadgeEnabled + the security flags Artifacts.EncryptionDisabled / Source.InsecureSsl / Source.ReportBuildStatus + the full S3-artifact shape (Name/NamespaceType/Packaging/Path/ArtifactIdentifier/OverrideArtifactName) + ResourceAccessRole/FileSystemLocations (EFS mounts) so a scope/network/visibility/logging/encryption/mount change is not silently projected away AND an S3-artifacts project is FP-clean; LogsConfig/BadgeEnabled/the boolean security flags are FP-safe because BatchGetProjects returns logsConfig=null / false when unconfigured and a live false folds via isTrivialEmpty. secondarySources/secondaryArtifacts/buildBatchConfig/autoRetryLimit are NOT yet projected — their read shapes diverge from the declared CFn shapes (secondaryArtifacts reads as BuildArtifacts, missing Type/Name/NamespaceType/Packaging) / carry server defaults / are order-sensitive — deferred to a per-field FP-safe pass). **Cognito IdentityPool** — the one read-ENRICH override (not a CC-API gap): CC reads every base property, but `CognitoEvents` / `PushSync` / `CognitoStreams` are writeOnly in the registry schema so CC never returns them. The reader reads the base via CC and enriches ONLY `CognitoEvents` (the "Cognito Events" Sync trigger) from the cognito-sync `GetCognitoEvents` API — gated on a non-empty map so a clean pool never false-positives; `PushSync`/`CognitoStreams` stay writeOnly readGaps. `CognitoEvents` is exempted from the writeOnly strip via `OVERRIDE_READABLE_WRITEONLY` so it is compared, and reverted via a `SetCognitoEvents` prop-scoped SDK writer (cognito-sync rejects an empty map and clears an event only via an empty-STRING value, so the writer re-sends dropped keys valued ""). Because CC mutates every base property fine, the type is in `CC_REVERTABLE_DESPITE_READ_OVERRIDE` (base reverts route through CC; only `CognitoEvents` takes the SDK writer). Also: a GetAtt attribute that mirrors a declared property (`GETATT_DECLARED_PROPERTY`, e.g. an IdentityPool's readOnly `Name` == its declared `IdentityPoolName`) resolves to the DECLARED value, not live, so renaming a pool out of band does not cascade into phantom drift on every consumer that bakes the name into its own declared property (the auto-created Role `Description`s). NOTE: where a reader projects a SUBSET, an out-of-band change to an un-projected property is a silent FN — coverage is widened as such gaps surface (e.g. Budgets CostFilters, the CodeBuild fields above).
  - **child-enumerators.ts** — `CHILD_ENUMERATORS`: per declared PARENT type, enumerate LIVE child resources and flag any not in the template → `added` tier (pass 1.6). Members: (1) API Gateway REST APIs — Resources + Methods via `getResources` embed=methods (CC `ListResources` is UnsupportedAction for Resource/Method, so the service SDK is used, mirroring SDK_OVERRIDES; identifier `RestApiId|ResourceId[|HttpMethod]`) and Authorizers via `GetAuthorizers` (composite `RestApiId|AuthorizerId`; a console-added TOKEN / REQUEST / COGNITO_USER_POOLS authorizer is security-relevant and invisible to cdk/CFn drift, and the RestApi model does not reflect its authorizers, so no double-report) and Models via `GetModels` (composite `RestApiId|Name`; declared models matched by Name since a Model's CFn physical id IS its Name; the AWS built-in `Empty`/`Error` default models, auto-created on every RestApi and never template resources, are filtered out so a clean deploy never surfaces them — mirroring the implicit root `/` resource, the GatewayResponse defaults, and the ELBv2 default rule) and Request Validators via `GetRequestValidators` (composite `RestApiId|RequestValidatorId`; declared validators matched by RequestValidatorId since a RequestValidator's CFn physical id IS its RequestValidatorId; the RestApi model reflects neither its models nor its validators inline, so no double-report) and Gateway Responses via `GetGatewayResponses` (single CC `Id` `RestApiId:ResponseType`, colon-joined — verified live; only customized responses (`defaultResponse: false`) are real resources — the ~17 API Gateway-generated defaults (`defaultResponse: true`) are filtered out so they never flag — declared gateway responses matched by ResponseType, and the RestApi model does not reflect its gateway responses inline, so no double-report); (2) API Gateway V2 (HTTP / WebSocket) APIs — Routes + Integrations via `GetRoutes`/`GetIntegrations` (identifier `ApiId|RouteId` / `ApiId|IntegrationId`) and Authorizers via `GetAuthorizers` (composite `AuthorizerId|ApiId`) and Stages via `GetStages` (composite `ApiId|StageName`; declared stages matched by StageName since a Stage's CFn physical id IS its StageName); the Api model does not reflect its authorizers or stages, so no double-report; (3) SNS Topics — Subscriptions via `ListSubscriptionsByTopic` (identifier = the bare `SubscriptionArn`; pending-confirmation / deleted subs, which have no real arn, are skipped); (4) Lambda Functions — Event Source Mappings via `ListEventSourceMappings` (identifier = the bare mapping UUID; the Function model does not reflect its mappings, so no double-report) and Function URLs via `ListFunctionUrlConfigs` (identifier = the bare FunctionArn of the URL config; an out-of-band public URL — especially `AuthType: NONE` — is security-relevant and invisible to cdk/CFn drift, and the Function model does not reflect its URL inline, so no double-report) and Aliases via `ListAliases` (identifier = the bare AliasArn; matched by AliasArn since an alias's CFn physical id IS its AliasArn, and the Function model does not reflect its aliases inline, so no double-report) and Versions via `ListVersionsByFunction` (identifier = the bare versioned FunctionArn; the `$LATEST` pseudo-version is skipped); (5) EventBridge event buses — Rules via `ListRules` (identifier = the bare rule Arn; only DECLARED custom buses are scanned so the AWS-default bus is out of scope, and AWS service-managed rules with `ManagedBy` set are skipped); (6) Cognito User Pools — Clients via `ListUserPoolClients` (composite `UserPoolId|ClientId`), Groups via `ListGroups` (composite `UserPoolId|GroupName`), and Resource Servers via `ListResourceServers` (composite `UserPoolId|Identifier`); the UserPool model reflects none of them, so no double-report; (7) AppSync GraphQL APIs — Data Sources via `ListDataSources` (identifier = the bare DataSourceArn; matched by Name since the Ref/physical-id form is unreliable) and Resolvers via `ListTypes` then `ListResolvers` per type (identifier = the bare ResolverArn; matched by `typeName|fieldName` since the physical-id form is unreliable) and Functions via `ListFunctions` (identifier = the bare FunctionArn); the GraphQLApi model reflects none of them inline, so no double-report; (8) CloudWatch Logs log groups — Metric Filters via `DescribeMetricFilters` (identifier = composite `LogGroupName|FilterName`) and Subscription Filters via `DescribeSubscriptionFilters` (identifier = composite `FilterName|LogGroupName` — note the REVERSE primaryIdentifier order vs metric filters, per the resource schema; an out-of-band subscription filter streams a log group's events to an arbitrary Lambda/Kinesis/Firehose destination, a log-exfiltration vector invisible to cdk/CFn drift); the LogGroup model reflects neither, so no double-report; (9) Elastic Load Balancing v2 load balancers — Listeners via `DescribeListeners` (identifier = the bare ListenerArn; the LoadBalancer model does not reflect its listeners, so no double-report); Elastic Load Balancing v2 listeners — Rules via `DescribeRules` (identifier = the bare RuleArn; the auto-created default rule (`IsDefault`) is skipped); (10) EC2 VPCs — Subnets via `DescribeSubnets` (identifier = the bare SubnetId; the VPC model does not reflect its subnets, so no double-report); (11) EC2 route tables — Routes via `DescribeRouteTables` (identifier = composite `RouteTableId|CidrBlock`; the auto-created VPC-local route is skipped, declared routes are matched by DestinationCidrBlock since a route's CFn physical id is a generated token, and the RouteTable model does not reflect its routes, so no double-report); (12) ECS clusters — Services via `ListServices` (identifier = composite `ServiceArn|Cluster`; a service's CFn physical id IS its ServiceArn, services are matched to their cluster by the declared `Cluster` resolving to the cluster name or ARN, and the Cluster model does not reflect its services, so no double-report); (13) KMS keys — Aliases via `ListAliases` (identifier = the bare AliasName; passing `KeyId` returns only aliases targeting that key, so AWS-managed `alias/aws/*` aliases are excluded, and the Key model does not reflect its aliases, so no double-report); (14) AppConfig applications — Environments via `ListEnvironments` (composite `ApplicationId|EnvironmentId`) and Configuration Profiles via `ListConfigurationProfiles` (composite `ApplicationId|ConfigurationProfileId`; declared profiles matched by ConfigurationProfileId since a profile's CFn physical id IS its ConfigurationProfileId); the Application model reflects neither its environments nor its configuration profiles, so no double-report; (15) EFS file systems — Mount Targets via `DescribeMountTargets` (identifier = the bare mount-target Id; the FileSystem model does not reflect its mount targets, so no double-report); (16) RDS DB clusters — DB Instances via `DescribeDBInstances` (filter db-cluster-id; identifier = the bare DBInstanceIdentifier; the DBCluster model does not reflect its members, so no double-report). Findings carry the CC primaryIdentifier so revert can DeleteResource them. The pure `diffApiGatewayChildren` / `diffApiGatewayAuthorizers` / `diffApiGatewayModels` / `diffApiGatewayRequestValidators` / `diffApiGatewayGatewayResponses` / `diffApiGatewayV2Children` / `diffApiGatewayV2Authorizers` / `diffApiGatewayV2Stages` / `diffSnsTopicChildren` / `diffLambdaFunctionChildren` / `diffLambdaFunctionUrls` / `diffLambdaFunctionAliases` / `diffLambdaFunctionVersions` / `diffEventBusChildren` / `diffUserPoolChildren` / `diffUserPoolGroups` / `diffUserPoolResourceServers` / `diffGraphQLApiChildren` / `diffGraphQLApiResolvers` / `diffGraphQLApiFunctions` / `diffLogGroupChildren` / `diffLogGroupSubscriptionFilters` / `diffLoadBalancerChildren` / `diffListenerChildren` / `diffVpcChildren` / `diffRouteTableChildren` / `diffEcsClusterChildren` / `diffKmsKeyChildren` / `diffAppConfigApplicationChildren` / `diffAppConfigProfiles` / `diffEfsFileSystemChildren` / `diffRdsClusterChildren` matchers are unit-tested offline.
- **normalize/** — noise subtraction (section 6)
  - **intrinsic-resolver.ts** — fail-closed CFn intrinsic resolver (section 5).
  - **noise.ts** — `isTrivialEmpty`, `isAllAwsTags`, `stripAwsTagsDeep`, `KNOWN_DEFAULTS` (top-level per-type service defaults → `atDefault`) + `KNOWN_DEFAULT_PATHS` (the nested-path twin: dotted paths with `*` for array elements, folds nested service defaults the CFn schema does not annotate; R108), `GENERATED_DEFAULTS` + `resolveGeneratedDefault` (per-type STRUCTURED auto-generated values templated on the physical id → `generated` tier; R104) + `isGeneratedName` (general rule: a scalar equal to the ARN physical id's name segment → `generated`, any type, no table entry; R107) + `isCfnGeneratedName` (a CloudFormation AUTO-mint physical name when no name is declared — `<stackName>-<logicalId>-<random>`, e.g. an undeclared SecurityGroup `GroupName` whose physical id is the unrelated `sg-…`; folds `generated` so an auto-named resource is not first-run noise. STRICTLY gated — must start with this stack's name [first construct-path segment] AND end with CFn's ~12+ char random suffix, and runs only in the UNDECLARED loop so a user-DECLARED name is never reached/hidden) + `GENERATED_PATHS` + `isPhysicalIdSegment` (nested paths whose value is an AWS-assigned id that ECHOES a physical-id segment cdkrd cannot template from a single placeholder — e.g. ApiGateway Method `Integration.CacheNamespace` = the PARENT Resource id, the middle segment of `RestApiId|ResourceId|HttpMethod`; folds as `generated` ONLY when the value matches a physical-id segment, so a CUSTOM value surfaces as drift; R140, id-echo gate R142), **`canonicalizeTagListsDeep`**, **`canonicalizeIdArraysDeep`**, `isJsonStringStructEqual` (object↔JSON-string), `isPemEqual` (PEM-armored value ↔ same body with surrounding-whitespace/trailing-newline differences, e.g. CloudFront PublicKey EncodedKey; R125), `UNORDERED_ARRAY_PROPS` (per-type unordered scalar arrays) / `UNORDERED_OBJECT_ARRAY_PROPS` + `sortUnorderedObjectArray` (per-type unordered object arrays — SG rules, R88) / `UNORDERED_NESTED_OBJECT_ARRAY_PATHS` + `sortNestedObjectArrays` (the nested twin: dotted paths reaching object-array sets one or more levels deep, e.g. Bedrock Guardrail `ContentPolicyConfig.FiltersConfig` — AWS canonicalizes the filter/topic/word/PII order) / `CASE_INSENSITIVE_PATHS` (per-type compare rules) / `LATEST_SENTINEL_PATHS` + `isLatestSentinelMatch` (per-type `"LATEST"` sentinel paths — Fargate ECS Service/TaskSet PlatformVersion resolves the literal `"LATEST"` to a concrete version; only the sentinel folds) / `PARAMETER_NAME_SUBSET_PATHS` + `alignParameterNameSubset` (per-type `[{ParameterName,ParameterValue}]` sets a service REORDERS and DEFAULT-FILLS — Kinesis Firehose processor `Parameters`: declared a SUBSET aligned BY ParameterName, so the false whole-array `declared` drift is suppressed and the live-only server-injected params [e.g. a Lambda processor's `NumberOfRetries`] surface as nested `undeclared` inventory; a genuine declared-param change still surfaces). (R95 removed the generic `projectLiveToDeclaredSubset` — it silently dropped out-of-band ADDITIONS to identity-keyed arrays like Tags. ELB attribute bags compare DECLARED keys as a subset via `ELB_ATTRIBUTE_BAGS` in classify, but their live-only keys are now ALSO emitted as nested `undeclared` inventory — fail-closed like every other identity-keyed array — so an out-of-band change to an UNDECLARED LB/TG attribute [routing.http2.enabled, deletion_protection.enabled, …] is recorded and watched instead of silently dropped; a live-only key whose value equals its curated server default in `ELB_ATTRIBUTE_DEFAULTS` folds to `atDefault` instead, to shrink the first-run `[Potential Drift]` noise of the ~15-20 server-default attributes — equality-gated per key, so a non-default value still surfaces.)
  - **arn-identity.ts** — **`isArnNameMatch`** (bare name ↔ ARN), **`isManagedKmsAliasMatch`** (`alias/aws/*` ↔ key ARN).
  - **policy-canonical.ts** — IAM policy-doc canonicalization. **cc-api-strip.ts** — strip AWS-managed fields (timestamps/owner/revision ids) by name at any depth, EXCEPT inside free-form user maps (Lambda `Environment.Variables`, Glue `Parameters`/`DefaultArguments`, `DockerLabels`/`Labels`, map-shaped `Tags`) where a managed-looking KEY is the user's data — stripping it would hide a real out-of-band change. **path-strip.ts** — schema readOnly/writeOnly path stripping (incl `*`).
- **schema/schema-strip.ts** — `describe-type` → readOnly/writeOnly/defaults + `unorderedScalarPaths` (arrays the schema marks `insertionOrder: false` with scalar items) `SchemaInfo` (cached).
- **diff/**
  - **classify.ts** — the heart: normalize both sides, then tag each difference into a tier.
  - **drift-calculator.ts** — pure structural diff (`calculateResourceDrift`), copied from cdkd.
- **baseline/baseline-file.ts** — git-committed baseline I/O (`.cdkrd/<stack>.<accountId>.<region>.json`), `applyBaseline`, `writeBaseline`.
- **config/config-file.ts** — git-committed project config (`.cdkrd/config.json`): `loadConfig` + `applyIgnores` (R32 path-level ignore rules → `ignored` tier).
- **revert/** — the write path (section 7): **plan.ts** (incl. a `delete`-kind item for an out-of-band `added` resource, and `REVERT_SET_DEFAULT_PATHS` — properties whose undeclared "appeared since record" revert must WRITE the known `KNOWN_DEFAULTS` default explicitly (an `add`) instead of an RFC6902 `remove`, because the provider leaves the value UNCHANGED when it is merely absent so a bare `remove` is a silent no-op: IAM Role `MaxSessionDuration` is the proven case — `UpdateRole` ignores an omitted value, so reverting an out-of-band 7200 back toward the 3600 default never converged; Lambda Alias `Description` is the same shape — `UpdateAlias` ignores an omitted description, so revert writes the empty-string default to clear it; Cognito IdentityPool `AllowClassicFlow` likewise — `UpdateIdentityPool` ignores an omitted flag, so a bare `remove` of an out-of-band `true` is a no-op and the `false` default is written explicitly (all proven live). Curated, not "every `KNOWN_DEFAULTS` entry": most properties already converge via `remove` (S3 `DeleteBucketOwnershipControls` re-defaults), and `KNOWN_DEFAULTS` holds read-side COMPARE shapes some of which are not valid CC write inputs), **apply.ts** (CC UpdateResource / DeleteResource + poll), **apply-ops.ts** (pure RFC6902 apply), **writers.ts** (SDK writers).
- **synth/** — **synth.ts** (`@aws-cdk/toolkit-lib` synth + `discoverStacks`), **resolve-app.ts**, **io-host.ts** (`QuietIoHost`).
- **report/report.ts** — tiered text + JSON + exit code. **report/style.ts** —
  TTY-only semantic colors (R43). **aws-errors.ts** — `isStackNotDeployed` etc.
  **types.ts** — shared types.

## 5. Intrinsic resolver (fail-closed + live-attr GetAtt)

[src/normalize/intrinsic-resolver.ts](../src/normalize/intrinsic-resolver.ts).
Resolves `Ref` / `Fn::Sub` / `Fn::If` (+ condition eval: Equals/And/Or/Not) /
`Fn::Join` / `Fn::Select` / `Fn::GetAtt` / `Fn::FindInMap` / `Fn::Split` /
`Fn::ImportValue` / `AWS::NoValue`, plus the `Fn::Sub` `${!Literal}` escape.
`Fn::FindInMap` resolves against `ctx.mappings` (from `template.Mappings`);
`Fn::ImportValue` against `ctx.exports` (CFn cross-stack exports — see below);
`Fn::Select` returns `UNRESOLVED` (not `undefined`) for an out-of-range index. All
of these are fail-closed: a missing mapping / export / non-string key → `UNRESOLVED`.

**Design rule: fail-closed.** Anything not _confidently_ resolvable returns the
`UNRESOLVED` sentinel, and the consuming property is reported in the `unresolved`
tier (skipped) — **never** a fabricated value that would show as false drift. A
condition that can't be cleanly evaluated does NOT guess a branch. This was a
load-bearing decision (it cut CDKToolkit's declared findings 11→2 in the PoC by
refusing to fabricate).

**`Fn::GetAtt` resolution (the 2-pass design).** GetAtt needs the referenced
resource's attributes, which aren't known at template-load time. So `gather`:
(pass 1) reads every resource's live model and populates
`ResolverContext.liveAttrs` (logicalId → live model); (pass 2) re-resolves each
resource's `declaredRaw`, so `Fn::GetAtt(X, Attr)` (and `${X.Attr}` Sub form,
dotted paths supported) resolves to X's **real live attribute** — not a guessed ARN
format. If X wasn't read or the attribute is absent → stays `UNRESOLVED`. This is
still real drift detection: it checks whether the consuming resource actually points
at that attribute's current value.

**`Fn::ImportValue` (cross-stack).** The resolver is synchronous, so exports can't be
fetched mid-resolve. `loadDesired` prefetches them — but ONLY when the template body
references `Fn::ImportValue` (a substring check), so a normal single-stack run pays
nothing — via paginated CFn `ListExports`, account+region-scoped, cached in a
module-level per-region Map. `Fn::ImportValue` then resolves a known export name to
its value, else `UNRESOLVED`.

> Trade-off to review: cdkd has a fuller `IntrinsicFunctionResolver`. We
> deliberately wrote a focused, fail-closed one. The remaining `unresolved`
> residual is exotic intrinsics — reported honestly, never false drift.

## 6. Noise model (why it stays low-noise)

The core insight (DESIGN.md): do NOT hand-maintain a watch allow-list (it explodes).
Snapshot full live state and **subtract** what existing tools / schema explain:

```
all live changes
  − declared (vs template)            → tagged "declared drift"
  − schema readOnly/writeOnly         → stripped (describe-type, nested + '*')
  − cc-api managed fields             → stripped (timestamps, revision ids)
  − policy-doc representational noise  → canonicalized (scalar/array, stmt order, acct-id↔root-ARN, Condition value-set)
  − aws:* tags ({Key,Value}[] anywhere; maps only under a `Tags` key — never
    IAM condition keys like aws:SecureTransport, R69) → stripped
  − schema defaults + known defaults  → tagged "atDefault" (R86): NOT dropped — folded
    into the info: footer as a count, so the report states the COMPLETE undeclared
    inventory but lists only the values that actually diverge. Equality-gated: change
    one away from its default and it re-tags as real undeclared drift. (`--show-all` /
    `--verbose` expand the fold to the full list; record never records an atDefault.)
  − auto-generated identifiers AWS assigns at deploy and absent from the template
    (a topic's minted TopicName, a Lambda's default LoggingConfig log group; if a name
    were in the template it would be declared, never reaching here) → tagged "generated"
    (R104): folded into the info: footer
    like atDefault, equality-gated against the physical-id-substituted template; never
    drift, never recorded by record. (`GENERATED_DEFAULTS` / `resolveGeneratedDefault`.)
  − pure structural noise (aws:* tags, physical-id echo, trivially-empty {}/[]) → dropped
  − Cloud Control MIS-ECHOES / ALT-REPRESENTS a value → dropped: AWS::EC2::Route's
    `VpcEndpointId` reflects the route's gateway target (`igw-…`/`nat-…`) on a non-endpoint
    route (a real VPC-endpoint route is `vpce-…`); AWS::EC2::Subnet's `AvailabilityZoneId`
    (`apne1-az4`) is CC's resolved form of the declared `AvailabilityZone`
    (`ap-northeast-1a`) — `CC_ALT_REPRESENTATION`, dropped when the declared sibling is
    present. Both are first-run noise on every public-subnet VPC.
  − tag-list / id-array / method-set ORDER → canonicalized (see below)
  − name↔ARN (either side), alias/aws/*↔key-ARN → collapsed (see below)
  − stringly-typed scalar (true vs "true", 5432 vs "5432") → equal (isStringlyEqualScalar)
    (scalars only — a typed vs string *array* like [80,443] vs ["80","443"] folds element-wise via isStringlyEqualScalarArray; a whole free-form `Map<String,String>` emitted as ONE record because a key holds a `.` — Glue Table `Parameters` `projection.enabled:true` vs live `"true"` — folds recursively via isStringlyEqualDeep, key-order-insensitive; a real key add/remove or value change still reports; fail-safe noise)
  − declared object vs its JSON-STRING live form (SSM Document.Content, R75) → equal (isJsonStringStructEqual)
  − PEM-armored value with only surrounding-whitespace differences (CloudFront PublicKey EncodedKey — AWS appends a trailing newline after the END marker, R125) → equal (isPemEqual); both sides must be PEM-armored, so a genuine key/cert change still differs
  − declared SUBSET of an ELB attribute bag (Load/TargetGroupAttributes) → DECLARED keys compared BY KEY (ELB_ATTRIBUTE_BAGS, R78); the live-only keys (the ~20 server defaults + any out-of-band custom attribute) are emitted as nested `undeclared` inventory — fail-closed like every other identity-keyed array — so `record` snapshots them and a later out-of-band change to an UNDECLARED attribute surfaces as drift instead of being silently dropped (a live-only key equal to its curated `ELB_ATTRIBUTE_DEFAULTS` value folds to `atDefault` to shrink first-run noise, equality-gated per key). NB (R95): the full-live compare is generic — every identity-keyed array (Tags, Origins, ELB bags, …) reports an out-of-band ADDED/CHANGED element rather than suppressing it
  − per-type case-insensitive scalar paths (Route53 AliasTarget.DNSName, R75; Batch ComputeEnvironment Type `managed`/`MANAGED`) → equal (CASE_INSENSITIVE_PATHS)
  − per-type `"LATEST"` sentinel paths (Fargate ECS Service/TaskSet PlatformVersion — declared `"LATEST"` reads back the concrete current version, e.g. `1.4.0`) → equal (LATEST_SENTINEL_PATHS / isLatestSentinelMatch); only the literal `"LATEST"` folds, so a declared concrete version still differs
  − per-type version tracks where declared and live differ only in PRECISION → equal (VERSION_PREFIX_PATHS / isVersionPrefixMatch, symmetric): partial→concrete (RDS DBInstance/DBCluster + Neptune/DocDB DBCluster + ElastiCache ReplicationGroup EngineVersion — declared `"8.0"`/`"1.3"` reads back the concrete provisioned patch `"8.0.45"`/`"1.3.5.0"`) AND concrete→partial (ElastiCache Memcached CacheCluster EngineVersion — declared `"1.6.22"` reads back the major.minor track `"1.6"`). The SHORTER must be a leading run of the LONGER, so a genuine track change still differs. (MSK KafkaVersion is NOT in the set — MSK validates against an exact supported-version list and rejects a partial, so declared == live.)
  − unordered scalar-array sets from TWO sources → equal: (1) the schema-driven `SchemaInfo.unorderedScalarPaths` — arrays the CFn schema itself marks `insertionOrder: false` with SCALAR items (ECS TaskDefinition RequiresCompatibilities, Route53 HealthCheck HealthCheckConfig.Regions/ChildHealthChecks, AutoScaling NotificationTypes, EKS NodePools, …), folded with NO per-type table and FN-safe (AWS declares them order-meaningless); (2) the per-type `UNORDERED_ARRAY_PROPS` allowlist for the sets AWS STILL sorts but the schema leaves `insertionOrder: true`/absent (most of them — Cognito UserPoolClient OAuth lists + CallbackURLs/LogoutURLs, Route53 RecordSet ResourceRecords, WAFv2 IPSet Addresses, CodeDeploy DeploymentGroup AutoRollbackConfiguration.Events, RDS-family EnableCloudwatchLogsExports, R74/R84). Both gated on the multiset being equal, so a genuine element change still differs.
  − per-type unordered OBJECT-array sets (EC2 SecurityGroup ingress/egress rules — no identity field, R88) → both sides sorted by canonical JSON (UNORDERED_OBJECT_ARRAY_PROPS / sortUnorderedObjectArray); the NESTED twin (Bedrock Guardrail ContentPolicyConfig.FiltersConfig etc.) sorts object-array sets at dotted paths (UNORDERED_NESTED_OBJECT_ARRAY_PATHS / sortNestedObjectArrays), descending through ARRAY segments too so a set nested inside an array element aligns (ECS TaskDefinition ContainerDefinitions.PortMappings + .VolumesFrom — AWS reorders each container's port-mapping / volumes-from sets; DynamoDB GlobalSecondaryIndexes.Projection.NonKeyAttributes — a nested SCALAR set AWS sorts alphabetically, handled the same way since canonical-JSON ordering covers scalars)
  − sibling AWS::IAM::Policy entries in a role's Policies → filtered BY NAME (see below)
  = undeclared residual                → the unique signal
      ├─ top-level: a live property the template never declared
      └─ nested (R96/R98): a live SUB-key inside a DECLARED object not set by it
         (recursed by classify's collectNestedUndeclared, dotted path, flagged
         nested:true) — SURFACED in full in the report like a top-level undeclared
         value (the R96 fold was removed): catalogued AWS defaults are stripped
         UPSTREAM (atDefault/generated/KNOWN_DEFAULT_PATHS/schema defaults), so a
         nested value that still reaches the report is a NON-default setting a user
         most likely changed out of band (e.g. an API Gateway method's
         Integration.PassthroughBehavior=NEVER) — exactly the differentiator. An
         uncatalogued AWS-populated nested value is quieted by EXTENDING
         KNOWN_DEFAULT_PATHS (the same catalogue model as top-level), never by hiding
         the whole class. Recorded by record like any undeclared value. The
         `freeFormKey` flag — a key under a FREE-FORM MAP property
         (SchemaInfo.freeFormMapPaths: a `type:object` schema node with no fixed
         `properties`, just `patternProperties`/object `additionalProperties` —
         Lambda Environment.Variables, Glue Parameters, and maps nested under an
         array element via a `*` path: ECS ContainerDefinitions.*.DockerLabels /
         .LogConfiguration.Options) — no longer affects VISIBILITY (all nested
         surface now) but survives for revertability semantics. A `Tags` bag is
         EXCLUDED from freeFormMapPaths even when map-shaped (AWS::SSM::Parameter
         models Tags as a patternProperties map; most types use a {Key,Value}[] LIST)
         so map-tag keys fold/normalize consistently with list-tag keys.
         R98 extends the recursion into the MATCHED elements of identity-keyed object
         arrays (Tags/Origins/AttributeDefinitions/…): elements are aligned by identity
         value and a live-only sub-field inside a declared element is caught too
         (path `Prop[<id>].sub`). Identity-LESS arrays (SG rules) are not descended —
         EXCEPT a per-type NESTED_ARRAY_IDENTITY override names a non-standard key, so an
         out-of-band sub-key on a declared element surfaces (and an AWS-materialized DEFAULT
         on those elements folds via KNOWN_DEFAULT_PATHS, so a clean stack stays clean):
         API Gateway Method Integration.IntegrationResponses AND MethodResponses (StatusCode)
         — SelectionPattern / ContentHandling / responseModels; Backup BackupPlan
         BackupPlanRule (RuleName) — a changed CompletionWindowMinutes / window; Route53
         Resolver FirewallRuleGroup FirewallRules (Priority) — a changed firewall-rule setting;
         SecretsManager Secret ReplicaRegions (Region) — a replica re-keyed to a different
         KmsKeyId (the alias/aws/secretsmanager default folds); ApiGateway Stage MethodSettings
         (HttpMethod) — a per-method CacheTtlInSeconds change (the 300 / false caching defaults
         fold). The CC-mutable ones (Backup, Route53 Resolver, Secret, ApiGateway Stage) revert
         via the generic Cloud Control index-revert writer (SDK_NESTED_WRITERS); a
         composite-identifier type addresses the resource by its CC_IDENTIFIER_ADAPTERS
         identifier (ApiGateway Stage `RestApiId|StageName`), not the bare physical id
```

### Why a given value does (or does not) appear

The subtraction above resolves, per live property value, to one outcome. This is the
decision tree `classify` walks for a value at key `k` NOT in the template
(`src/diff/classify.ts`, the undeclared loop) — it answers the common "why is THIS
showing / why is THAT silent" question in one place:

```
a live value at key k, not declared in the template
  ├─ == a schema default (CFn `default` annotation) OR == KNOWN_DEFAULTS[type][k]
  │        → atDefault   (folded into info:, NOT drift, NOT recorded; equality-gated,
  │                       so a value changed AWAY from the default re-tags as undeclared)
  ├─ == this resource's OWN minted value (generated name / ARN name-segment /
  │     GENERATED_PATHS id-echo) → generated   (folded like atDefault; only the
  │                       resource's own identity, never a reference to ANOTHER resource)
  ├─ pure structural noise: all-`aws:*` tags · == physicalId echo · trivially-empty
  │     (`false` / `""` / `[]` / `{}`, isTrivialEmpty) → DROPPED   (no finding at all)
  └─ otherwise → undeclared → reconciled against the baseline:
        ├─ recorded & unchanged → suppressed (CLEAN)
        ├─ recorded & changed   → DRIFT
        └─ not recorded         → [Potential Drift] (no baseline yet, NOT confirmed drift)
```

So three independent things make a value SILENT without a baseline: it is absent
from the live read, it is dropped as noise, or it equals a default cdkrd can PROVE
(a schema default or KNOWN_DEFAULTS). A value reaches **[Potential Drift]** precisely
when cdkrd CANNOT prove it is a default/generated/noise and it is not yet in the
baseline — including a property whose default cdkrd simply does not know yet (a
long-tail / minor resource type). That is **expected, not a bug or a false
positive**: it is the accepted residual of the subtractive bet (the long-tail
"explainable defaults not in any schema" risk named in Bet 1 above), and the
baseline is the universal backstop — `record` once accepts it and the stack stays
CLEAN until reality changes. Widening atDefault coverage (more `KNOWN_DEFAULTS` /
`KNOWN_DEFAULT_PATHS`) shrinks that residual; because the fold is equality-gated it
can never hide a real change, so widening is safe — but the baseline means cdkrd
never has to know every default to be correct.

How much of the fold does the SCHEMA carry on its own? Almost none. Measured over
the public CloudFormation resource-schema set (1605 types, 2026-06-22 — re-run with
`scripts/measure-schema-defaults.mjs`), only **~1% of properties carry a `default`
annotation** (1.10% top-level, 1.34% incl. nested; just 5.5% of types have any —
e.g. Lambda `MemorySize`/`Timeout` have none). So `schema.defaults` is negligible:
the low-noise outcome comes overwhelmingly from (a) properties ABSENT from the live
read when unset, (b) the `isTrivialEmpty` drop, and (c) the hand-maintained
`KNOWN_DEFAULTS` / `KNOWN_DEFAULT_PATHS`. The hand tables are therefore the real
lever, and growing them is done DATA-DRIVEN rather than by guessing: the offline
first-run-noise sweep (`scripts/measure-noise.sh` →
[tests/measure-noise.test.ts](../tests/measure-noise.test.ts)) replays classify over
the golden corpus and ranks every `undeclared` `(type, path)`, flagging the
constant-looking ones as `*_DEFAULTS` candidates; `/hunt-bugs` runs it after
deploying uncovered types (recording fresh corpus) to surface new promotions.

**The four false-positive classes found by dogfooding** (8 real cdkd fixtures —
vpc-lambda / sns-sqs / rds / iam / s3-cloudfront / ecs-fargate / appsync / a mixed
stack) and fixed, each with paired regression tests asserting _noise suppressed_ AND
_real change still detected_ ([tests/classify.test.ts](../tests/classify.test.ts)):

1. **Identity-keyed object-array order** — CFn `Tags` (`{Key,Value}[]`) AND CloudFront
   `DistributionConfig.Origins` (`{Id,...}[]`) are unordered sets; a positional diff
   flagged every CDK-tagged resource (and every field of every swapped origin on a
   multi-origin distribution). Fix: `canonicalizeTagListsDeep` sorts arrays whose every
   element is an object with a string identity field (`Key`, `Id`, or — R88 — DynamoDB's
   `AttributeName` / `IndexName`). Identity-LESS unordered object arrays (EC2
   SecurityGroup ingress/egress rules) have no such field and are instead sorted by
   canonical JSON per-type (`UNORDERED_OBJECT_ARRAY_PROPS`, R88) in the classify loop.
2. **resource-id/ARN/HTTP-method array order** — `SubnetIds` / `SecurityGroupIds` and
   HTTP-method enum sets (CloudFront `AllowedMethods` / `CachedMethods`) are unordered;
   positional diff flagged them. Fix: `canonicalizeIdArraysDeep` (sort arrays whose
   every element is an AWS id `subnet-…`/`sg-…`, an ARN, or an HTTP verb; plain scalar
   lists untouched). EXCEPTION: a list containing a Lambda layer-version ARN
   (`…:lambda:…:layer:…`) is order-SIGNIFICANT (later layers overlay earlier), so it is
   left unsorted — a genuine `Layers` reorder surfaces as drift, not a false negative.
3. **name ↔ ARN (bidirectional)** — CDK declares a bare name (Lambda
   EventSourceMapping/Permission `FunctionName`, ECS `Service.Cluster`) and AWS returns
   the full ARN; OR the reverse — the template resolves a `Fn::GetAtt` to an ARN
   (`AWS::Lambda::Url.TargetFunctionArn`) but the live read returns the bare name. Fix:
   `isArnNameMatch` (value-shape: EXACTLY one side is an ARN, the other is its final
   `:`/`/` segment; never hides drift to a _different_ name). When the stack's account +
   region are known they are also required to match the ARN's region/account segments
   (when non-empty), so a same-named resource swapped to a _different account or
   region_ is reported as genuine drift; empty-segment ARNs (e.g. S3) stay suffix-only.
4. **managed-default KMS alias** — `alias/aws/rds` declared vs resolved key ARN. Fix:
   `isManagedKmsAliasMatch` (only collapses `alias/aws/*`, not custom aliases). When
   the stack declares any `alias/aws/*`, `gather` prefetches the account's
   alias→target-key map (KMS `ListAliases`, per-region cached) and the match becomes
   **strict**: the live key must be the alias's managed key, so a customer-managed key
   swapped in out of band (a security-relevant change) IS reported as drift. Without
   `kms:ListAliases` it falls back to the shape-based collapse (noise, never a false
   positive) — but `gather` then prints a one-line per-region warning
   (`kmsListAliasesDeniedWarning`, deduped via a process-lifetime region set), so the
   degraded coverage (blind to a key swap) is surfaced rather than silent (R115).

> Classes 1 & 3 are a latent risk in any AWS-snapshot diff; they were also
> back-ported to **cdkd** (PR #802, merged) since cdkd's `drift-calculator` shared
> the same positional comparison. See section 11.

**A second dogfood on a larger real app** (a ~40-resource API stack: Lambda Function
URLs + CloudFront + Glue + many Custom Resources) surfaced three further refinements,
each now covered by a unit test: (a) the **name↔ARN reverse direction** above
(`Lambda::Url.TargetFunctionArn` — 5 false declared drifts); (b) the **HTTP-method set
order** above (CloudFront `AllowedMethods` — 1 false declared drift); (c) **read-path
throttling** — on a stack that big the bounded-concurrency Cloud Control reads hit
`ThrottlingException` and were reported as `skipped` (silent coverage loss), so the
CC / CloudFormation / SDK-override clients now use `adaptive` retry with a higher
attempt budget ([src/read/client-config.ts](../src/read/client-config.ts)). The same
dogfood also fixed the synth IoHost printing the CDK app's stderr passthrough (bundling
progress, tagged `CDK_ASSEMBLY_E1002`/error by toolkit-lib) in alarming **red** —
`planIoMessage` re-tags app passthrough to the default color, matching cdk-local
([src/synth/io-host.ts](../src/synth/io-host.ts)).

**Sibling `AWS::IAM::Policy` entries are filtered BY NAME, not suppressed
wholesale.** The CDK grant pattern puts a role's permissions in a sibling
`AWS::IAM::Policy` resource (the "DefaultPolicy"), which reflects into the role's
live `Policies` — pure noise on the role, since the sibling resource's own check
already owns its content drift. But suppressing the role's whole `Policies`
property would also hide an out-of-band inline policy added NEXT to the sibling —
exactly the differentiator case. So the template adapter maps each role to its
sibling **PolicyNames** (`collectRolesWithSiblingPolicies`,
[template-adapter.ts](../src/desired/template-adapter.ts)) and classify drops only
the live entries matching those names — the residual (rogue inline policies)
surfaces as undeclared drift. A sibling `PolicyName` the resolver can't evaluate
statically (an `Fn::Sub`/`Fn::Join` name, or none) now **fails OPEN** (R111): the
role keeps its whole live `Policies`, so a rogue out-of-band policy is never hidden
— the sibling-managed entries merely surface as undeclared (baseline-able once).
The old fallback DELETED the property, which also hid out-of-band additions on a
security-relevant resource (the dangerous DROP class, R95); a visible one-time
false positive is the right trade against a silent false negative.

**The `isTrivialEmpty` asymmetry (intentional trade-off).** An undeclared value that
is `false`, `''`, `[]`, or an object whose every value is itself trivially empty
(recursively — `{}` included) is suppressed (`isTrivialEmpty` in noise.ts) — AWS
returns a "feature off / empty" value for almost every unset option, so without this
the undeclared residual would be dominated by `X: false` noise on every resource.
The object recursion covers feature-off STRUCTS AWS materializes (e.g. the empty
`VpcConfig {Ipv6AllowedForDualStack:false, SecurityGroupIds:[], SubnetIds:[]}` a
Lambda reports after a Cloud Control update — R46); arrays stay length-0-only.
The cost: on the FIRST run / under `--show-all` (inventory), an explicitly-OFF
feature is **not shown** (you can't see "encryption is false" in the inventory). The
asymmetry is one-directional and self-correcting for the case that matters: once a
non-trivial value is recorded and then changes to `false`/empty out of band, the
baseline removal-detection (§8) DOES surface it. We deliberately do NOT skip
`isTrivialEmpty` under `--show-all` — that would re-flood inventory with the very
`false`/empty noise the subtractive model exists to remove. (Considered and rejected;
see [redesign-notes.md](redesign-notes.md).)

## 7. Revert (the only AWS-mutating path)

[src/revert/](../src/revert/). `revert` builds a plan, prints it (revertable items
always in full — per finding: path, current → target; NOT-revertable findings folded
to one line per reason, `--verbose` for the full list — R35), then in a TTY shows a
**multiselect of the op(s) to write** (R57 — symmetric with record's multiselect:
every op starts unselected (R137); REMOVE ops, which DELETE a live value not in the
baseline, are labeled `(REMOVE)`, and a whole out-of-band `added` resource is a
`delete`-kind item labeled `(DELETE)` that removes it via Cloud Control
`DeleteResource` — so each destructive write stays an explicit per-item choice;
picking nothing aborts), asks for confirmation with the selected
op count (`@clack`; `--yes` skips both and applies the full plan; non-TTY
refuses; `--dry-run` previews), applies, then
**re-checks for convergence**. The convergence re-check is **scoped to the
resources the revert touched** (R44, `regatherTouched` in
[gather.ts](../src/commands/gather.ts)): only the plan's resources are re-read
and re-classified; every other resource's findings carry forward from the
pre-revert gather. The template can't have changed (revert writes live state,
not CFn), and a full re-gather made `revert` hang silently for
whole-stack-read time after the last `reverted:` line — it could even blame
unrelated mid-revert drift on the revert. A `verifying convergence (re-reading
N resource(s))...` line attributes the wait, and if a touched resource still
reads as drifted, ONE re-read after a short delay guards against SDK-writer
eventual consistency (the slow full re-gather used to grant that propagation
time by accident). When drift survives, each surviving finding is listed
(id.path + tier) under the `N drift(s) remain.` line so the user doesn't have
to re-run `check` to learn what failed to converge (R46); if unrecorded values
remain after a clean revert, one dim pointer line names the count (they are not
drift, but silence would read as "all decided" — R62). Exit semantics: no
drift at all → `no drift to revert.` + exit 0; findings exist but **nothing
is revertable** →
`nothing revertable — N drift(s) + M unrecorded value(s) remain.` (each part
only when non-zero — unrecorded values are named as such, never folded into
"drift", R62) + exit 1 (drift-remains semantics, not a usage error — R35).

- **Targets**: declared drift → the **deployed-template** value; undeclared drift →
  the **baseline** value (an out-of-band _addition_ that appeared since a
  snapshot-complete record reverts by REMOVAL).
- **Unrecorded safety guard (R62, relaxed for interactive prompts by R113)**: a value
  the user never decided on (no baseline entry, resource never snapshot-complete —
  which includes every undeclared value on a no-baseline stack) is reported as
  `notRevertable` (`unrecorded — record it if the live value is right, or
--remove-unrecorded to remove it`) **in a no-prompt run** (`--yes` or non-TTY) —
  there the un-guarded revert mirror would be **destructive** (a bulk REMOVE of every
  undecided value that slipped through subtraction). But in a gated interactive
  prompt (TTY, no `--yes`) the standout undeclared values ARE surfaced as opt-in
  REMOVE rows (`includeUnrecordedRemovals`, R113): the multiselect's unselected-by-
  default rows are the per-item consent the flag provides, so listing them — like
  declared drift — is consistent with showing them as `[Potential Drift]`, and no flag is
  needed. Declared drift is always revertable (the template is its source). For
  unrecorded values this guard outranks the create-only guard (R35): the fundamental
  blocker is "no revert target exists" — a "requires replacement" reason would
  mis-direct. The guard's wording is a FORK, not a sequence (R55): `record`
  endorses the live value (it stops being drift entirely — record is never a step
  toward reverting that same value), while `--remove-unrecorded` removes it. When
  the guard fires, the plan leads with a note spelling out that fork.
- **Write mechanism** (`plan.ts` chooses `kind`):
  - `kind: 'cc'` — generic Cloud Control `UpdateResource` RFC6902 PatchDocument,
    polled via `GetResourceRequestStatus` ([apply.ts](../src/revert/apply.ts)).
  - `kind: 'sdk'` — type-specific SDK writer for CC-unwritable types
    ([writers.ts](../src/revert/writers.ts)): reads current model → `applyOps`
    ([apply-ops.ts](../src/revert/apply-ops.ts), pure) → SDK `Put*`. Covers
    `AWS::S3::BucketPolicy`, `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`,
    `AWS::IAM::Policy`, and `AWS::IAM::ManagedPolicy` (`CreatePolicyVersion` +
    SetAsDefault, pruning the oldest version at the 5-version cap),
    `AWS::ServiceDiscovery::HttpNamespace` (`UpdateHttpNamespace`),
    `AWS::DocDB::DBCluster` (`ModifyDBCluster`), and
    `AWS::CloudFront::Distribution` — CloudFront is CC-READABLE but its
    `UpdateResource` REJECTS even a minimal single-property patch (applying it
    re-validates the whole distribution and the default ViewerCertificate trips a
    `SslSupportMethod` validation, proven live — EVERY CloudFront revert failed),
    so revert reads `GetDistributionConfig`, applies the ops, and re-submits the
    full config via `UpdateDistribution(IfMatch=ETag)` so AWS's own
    ViewerCertificate round-trips verbatim (robust for the common scalar
    `DistributionConfig` drifts: Comment / DefaultRootObject / Enabled / …).
    `AWS::WAFv2::WebACL` is the SAME CC-revalidation class: its `UpdateResource`
    re-validates the whole WebACL and AWS's own empty `Description` ("") fails the
    schema's Description pattern (proven live — every WebACL revert failed), so revert
    reads `GetWebACL` (Name|Id|Scope physical id), applies the ops, and re-submits via
    `UpdateWebACL(LockToken)` OMITTING an empty Description (every other updatable field
    round-trips verbatim). KNOWN LIMITATION: a `DefaultAction` revert (the Allow⇄Block
    mutually-exclusive union) still fails — the per-leaf revert op adds the desired
    branch without removing the live one ("exactly one value" error); that union-op
    granularity is a plan-level gap affecting the CC path too, deferred.
    `AWS::Glue::Job` is the SAME class for a WorkerType job: AWS returns a computed
    `MaxCapacity` and CC `UpdateResource` re-submits it alongside `WorkerType`, failing
    "do not set Max Capacity if using Worker Type" (proven live), so revert reads
    `GetJob`, applies the ops, and re-submits via `UpdateJob` OMITTING
    MaxCapacity/AllocatedCapacity when WorkerType is set (other JobUpdate fields verbatim;
    read-only CreatedOn/LastModifiedOn excluded). `AWS::OpenSearchService::Domain` is the
    SAME class: CC `UpdateResource` re-submits the full model and AWS's own legacy
    `override_main_response_version` AdvancedOption is rejected as "Unrecognized advanced
    option" (proven live); revert goes through `UpdateDomainConfig` (a PARTIAL API)
    sending ONLY the option properties the ops touch, so the untouched AdvancedOptions is
    never re-submitted (and an AdvancedOptions revert drops the AWS-managed key). The
    recurring shape: a CC type is READABLE but its full-model UpdateResource re-validation
    rejects a field AWS itself returns — the per-type SDK writer re-submits via the
    resource's own update API, omitting the offending field. Only a LIVE
    detect→revert→CLEAN cycle catches these.
  - **Property-scoped SDK writers** (`SDK_PROP_WRITERS`): a CC-writable type where
    ONE property must bypass Cloud Control. An IAM Role's top-level `Policies`
    finding reverts per entry (`DeleteRolePolicy` / `PutRolePolicy` by
    PolicyName, driven by the op's `value` + `prior`) — a CC `remove /Policies`
    would also wipe the sibling-managed DefaultPolicy entries that classify
    filtered OUT of the finding (§6). The ELB attribute bags
    (`LoadBalancerAttributes` / `TargetGroupAttributes`) revert per attribute via
    `ModifyLoadBalancerAttributes` / `ModifyTargetGroupAttributes` (R78): classify
    emits one declared finding per changed Key (`Finding.attributeKey`), and the
    writer sends ONLY those `Key=Value`s — a CC index patch would misalign against
    the full live bag (the template declares a subset) and exceed ELB's
    20-attribute-per-call cap. A CloudWatch Logs log group's
    `BearerTokenAuthenticationEnabled` reverts via `PutBearerTokenAuthentication`
    (the dedicated control-plane API): CC `UpdateResource` FAILS on this newer
    boolean — its LogGroup update handler's downstream call errors with "The
    security token included in the request is invalid" (proven live) — so the
    writer toggles it directly (a `remove` reverts to the schema default DISABLED;
    an `add` carries the desired boolean). An `AWS::Config::ConfigRule`'s
    `InputParameters` (a `JSON_STRING_PROPS` property — Config stores it as one JSON
    string) reverts via `PutConfigRule`, writing a COMPACT JSON string with
    string-coerced param values: a CC `UpdateResource` re-serializes the JSON into
    Config's string field with spaces / a numeric value, which the provider rejects
    ("Blank spaces are not acceptable for input parameter" — proven live). classify
    reports such a property WHOLE at its top-level path (never a fragile sub-path
    finding). Scoped to the EXACT top-level path: deeper
    `Policies.*` declared drift still patches via CC. A resource with both kinds
    of findings splits into one `cc` item and one `sdk` item.
- **Not revertable (reported honestly, never silently skipped)**:
  `AWS::Lambda::Permission` (add/remove statement model keyed by StatementId, not a
  settable document), `AWS::Budgets::Budget` (`UpdateBudget` needs a full NewBudget
  the reader can't reconstruct), a `deleted` resource (`deleted — recreate via cdk
deploy`: a patch can't recreate a resource), a **create-only** property (drift on a
  HARD `createOnlyProperties` field needs a resource replacement, which an in-place
  `UpdateResource` can't do — caught from the schema at plan time, not at apply
  time; `conditionalCreateOnlyProperties` are NOT barred — they are create-only only
  in specific cases and mutable in the common one, e.g. RDS `BackupRetentionPeriod` /
  `MultiAZ` / `StorageType`, so revert attempts them and Cloud Control rejects
  cleanly if a change truly needs replacement), and a nested undeclared value whose
  path
  addresses an **array element** (`Prop[<id>].sub` — the bracket can't be expressed
  as an RFC6902 pointer), plus any `readGap` / `unresolved` / `skipped` finding. A
  nested undeclared value on a PURE-DOTTED path IS revertable — Cloud Control applies
  the dotted pointer read-modify-write (`isUnrevertableNested`): a free-form map key
  (a Lambda env var), an object sub-field, OR a **map-shaped tag key** (`Tags.<key>`,
  e.g. AWS::SSM::Parameter — a single-key `remove`/`add` leaves the live `aws:*`
  managed tags untouched, proven live). EXCEPTION — even an ARRAY-ELEMENT nested path
  a type-specific `SDK_NESTED_WRITERS` entry can target PRECISELY is revertable
  (`isNestedSdkWritable`, the same lift `isManagedPolicyAttachmentMember` gets): an
  API Gateway Method's `Integration.{PassthroughBehavior,ContentHandling,TimeoutInMillis}`,
  `IntegrationResponses[<statusCode>].{SelectionPattern,ContentHandling}`, and
  `MethodResponses[<statusCode>].ResponseModels` revert via the native granular patch API
  (UpdateIntegration / UpdateIntegrationResponse / UpdateMethodResponse PatchOperations) —
  API Gateway REJECTS `op: remove` for the integration knobs (so the reset is a `replace`
  to the AWS default, or `""` which reads back absent/folded), but ACCEPTS `op: remove` for
  a `responseModels` entry (removed per media key) — all proven live. For a CC-MUTABLE type
  the array-element nested value reverts via the generic **Cloud Control index-revert**
  writer (`writeCloudControlIndexNested`, registered for Backup BackupPlan + Route53Resolver
  FirewallRuleGroup + SecretsManager Secret ReplicaRegions + ApiGateway Stage MethodSettings):
  it GetResources the live model, RE-POINTS each op's identity bracket to
  the live-array INDEX (`/FirewallRules[100]/…` → `/FirewallRules/1/…` — valid because the
  index is taken against the SAME model CC read-modify-writes; R78's index problem was
  indexing the DECLARED subset), then one UpdateResource. It addresses the resource by the
  CC identifier the READ path resolves (`CC_IDENTIFIER_ADAPTERS`, e.g. ApiGateway Stage
  `RestApiId|StageName`) carried on `ctx.identifier`, NOT the bare physical id, or a
  composite-identifier type ValidationExceptions (`Identifier prod is not valid …` — found
  live for #419). A value AWS materialized as a
  default (KNOWN_DEFAULT_PATHS) reverts by SETTING that default (`add`), not a bare `remove`
  some providers silently ignore (Route53 FirewallDomainRedirectionAction — proven live).
  KMS keys need no SDK writer — they revert via the generic CC path.
- **Canonical-form write**: a declared-drift revert target (`finding.desired`) is the
  _normalized_ value (policy statements sorted, scalar-vs-array collapsed, tag / id
  arrays sorted), not the template verbatim. It is semantically equal to the template
  but the written value may differ **textually** (ordering, scalar-vs-array) from
  what you wrote in code. This is expected — the comparison is structural, so the
  revert writes the structural form.
- **Known limitation**: toggle-style props with no "absent" state (e.g. S3 transfer
  acceleration is only Enabled/Suspended) can't be reverted by removal.

## 8. Baseline model

This section is the mechanics. The design rationale — why the baseline must be
state at all, and why neither schema defaults nor `.cdkrd/config.json` can
replace it — lives in [why-a-baseline-file.md](why-a-baseline-file.md).

`record` snapshots the current undeclared state — and (PR4) any out-of-band
`added` resource's full normalized model, as a `recorded` entry with an empty
`path` — into a **git-committed** file
`.cdkrd/<stack>.<accountId>.<region>.json` ([baseline-file.ts](../src/baseline/baseline-file.ts)):

```jsonc
{ "schemaVersion": 2, "stackName": "...", "region": "...",
  "accountId": "<aws account the baseline was captured in>",
  "capturedAt": "<iso>", "templateHash": "<hash of deployed template>",
  "recorded": [ { "logicalId", "resourceType", "path", "value" }, ... ],
  "completeResources": [ "<logicalIds the record snapshot fully covered>" ] }
```

**Per-entry classification (R62).** The unit of "recorded" is the ENTRY, not the
file: an undeclared finding with a matching entry is suppressed; with an entry
whose value differs it is **drift**; with NO entry it is drift only when its
resource is in `completeResources` (the record covered that whole resource, so
the value **appeared since record** — noted as such); on any other resource the
user never decided, so it is **UNRECORDED** (see §13). File existence alone
decides nothing — a cherry-pick record of one value must not flip the other
hundred from unrecorded to drift, and `record 0 → CI green / record 1 → CI red`
would be incoherent. `completeResources` is computed at write time (every
undeclared finding of the resource is in `recorded`; zero findings = trivially
complete; a `skipped`/`deleted` resource is never complete) and is **monotonic**
across re-records (declining a newly-appeared value keeps it drift instead of
demoting it back to unrecorded). A schema-v1 file (no `completeResources`) still
loads — nothing is complete, so appeared-since-record values read as unrecorded
until the next `record` upgrades the file (a stderr note says so).

`accountId` is in the **filename**, not just a field (R21): the same stack name
deployed to dev + prod (the very common `env: { account: PERSONAL || SHARED }` CDK
pattern) gets one baseline file PER account, so they never collide and a
personal-account run is not blocked by a committed shared-account baseline. Because
the filename embeds the accountId — which only a gather (`DescribeStackResources`)
resolves — `loadBaseline` is called AFTER the desired model is built (check was
already gather-then-load; revert + record's overwrite-check were reordered to match).
The `accountId` FIELD remains as a **secondary guard** (`checkBaselineAccount`):
a correctly-named file always matches, so it now only catches a file hand-copied or
renamed to the wrong account's path (exit 2). A pre-release file with no `accountId`
field only warns and is stamped on the next `record`.

> No legacy-path fallback: cdkrd is pre-release (unpublished), so the only old-style
> `<stack>.<region>.json` files are local dogfood artifacts. They are simply not found
> under the new path (→ "no baseline", run `record`); delete them after re-recording.

When a baseline already exists, the interactive `record` multiselect shows only the
**delta** from it (`splitRecordedByBaseline`) — new/changed undeclared values, where
"unchanged" reuses the same `baselineValueMatches` predicate as `applyBaseline`
(R6 — canonicalized compare); already-recorded unchanged values are auto-kept (noted,
not re-confirmed) and a delta of zero just refreshes the file (R39).

Committing it makes "what real state we record" a visible, reviewable PR change.
With revert it is also the _source of the undeclared target value_, so it is
structural, not optional. `check` filters undeclared findings against it
(`applyBaseline`), so a stack with an recorded baseline reports CLEAN; `--show-all`
ignores it.

**Promotion into the template.** The recommended way to resolve undeclared drift is
to _declare_ it in the CDK code. After that, the recorded path is no longer
undeclared, so the naive removal check would mis-report it as "baseline value
removed since record". `applyBaseline` is passed the set of currently-declared keys per resource
(`declaredKeysByLogical`) and suppresses that false removal, emitting a one-line
stderr note ("now declared in the template — re-run `cdkrd record`") instead. So the
behavior we recommend is never punished as drift.

**Stale-baseline warning.** `templateHash` (sha256 of the deployed template at
capture) is verified on load (`warnTemplateHashDrift`): a mismatch prints a non-fatal
note suggesting a re-`record` (the recorded set may be stale). Skipped under
`--pre-deploy`, where the synth template legitimately differs from the deployed one.

## 9. Tier semantics (the output contract)

| tier         | meaning                                                                 | exit-affecting |
| ------------ | ----------------------------------------------------------------------- | -------------- |
| `deleted`    | a resource present in the template but gone from AWS (deleted OOB)      | yes (always)   |
| `declared`   | a declared property whose live value differs from the template          | yes (always)   |
| `undeclared` | a live property not in the template, after noise subtraction            | yes (default)  |
| `ignored`    | a declared/undeclared/added finding matched a `.cdkrd/config.json` rule | no             |
| `readGap`    | a declared property the live read can't return (CC can't read back)     | no             |
| `unresolved` | a declared property whose intrinsics couldn't be resolved (skipped)     | no             |
| `skipped`    | resource unreadable (CC unsupported / no physical id / custom resource) | no             |

`deleted` is the most blatant drift — a resource the template still declares no
longer exists in AWS (released/deleted via the console, another tool, etc.). The
live read returns a not-found error (`ResourceNotFoundException` from Cloud
Control; `NoSuchBucket` / `QueueDoesNotExist` / `NoSuchEntity` / `InvalidAllocationID.NotFound` /
… from the SDK overrides), which the router maps to `deleted`. It is always a
drift tier and is reported as `not revertable`
(reason: `deleted — recreate via cdk deploy`) — a patch cannot recreate a
resource.

**Exit (R53, the `cdk diff --fail` / `cdk drift --fail` convention):** `check`
is report-only by default — drift prints but exits 0, with a stderr note naming
the flag. `--fail` makes drift exit 1 AND
suppresses all prompts: one flag expresses "automation" (locally-run scripts
inherit the terminal's TTY, so prompts would otherwise fire mid-script). Errors
always exit 2. All three of `deleted` / `declared` / `undeclared` count as
failing drift. `ignored` / `readGap` / `unresolved` / `skipped` are
informational — surfaced, never silently dropped, but never false drift.

A declared property absent from the live read: a declared NON-EMPTY **collection**
(object/array) is real `declared` drift BY DEFAULT — many services OMIT a sub-config
when empty but RETURN it when set (EC2 SecurityGroup ingress/egress rules, IAM inline
`Policies`, every S3 sub-config — `Cors`/`Lifecycle`/`Website`/`OwnershipControls`/…,
Lambda `Environment`), so its absence means the whole config was removed out of band.
Swallowing that as a `readGap` was a silent FALSE NEGATIVE (the removal reported
CLEAN). classify emits one whole-property finding so revert re-applies it with a
single top-level `add`. The EXCEPTIONS stay `readGap` (informational, never false
drift): a **scalar** (AWS may legitimately not echo one), an **empty** declared
collection (declared `{}`/`[]` vs absent is not drift), and the small curated
`READGAP_COLLECTION_PATHS` (`normalize/noise.ts`) DENYLIST of collections AWS never
returns even when set (Batch `Timeout`, Budgets `NotificationsWithSubscribers`,
DynamoDB `SSESpecification`) — derived from a full golden-corpus audit. This closes
the whole removed-collection FN class for every type at once; a new genuine readGap
surfaces as a VISIBLE, denylist-able false positive, never a silent FN.

`ignored` (R32) is for properties an external system legitimately keeps rewriting —
Application Auto Scaling moving an ECS Service `DesiredCount`, DynamoDB autoscaled
capacity, externally-managed Lambda reserved concurrency. Because `record` is a value
snapshot, recording such a property would re-detect and force a re-record every time
the value moves. Path-level ignore rules (the `.driftignore` / Terraform
`ignore_changes` equivalent) live in a git-committed **`.cdkrd/config.json`** —
deliberately separate from the baseline, which `record` rewrites wholesale (a
hand-written rule there would be erased), and because a rule is app-wide intent, not
a per-stack/account fact:

```jsonc
{
  "ignore": [
    { "path": "*.DesiredCount" }, // unscoped — any stack, any region, any logical id
    { "path": "Fn*.ReservedConcurrentExecutions", "stack": "Prod*" }, // stack-scoped
    { "path": "*.DesiredCount", "region": "us-*" }, // region-scoped (independent axis)
  ],
}
```

Every rule is an object `{ path, stack?, region? }` (one uniform, self-labelling
shape — no bare-string shorthand); `path` is the pattern, `stack` / `region` are
optional scopes (absent = any). Region is an independent axis from the stack name
(the same stack name may be deployed to several regions, or matched by a `*` stack
glob, and a property may legitimately drift in only one), so the current region
is threaded in.
`applyIgnores(findings, stackName, region, config)`
([src/config/config-file.ts](../src/config/config-file.ts)) is a pure function
applied right after `applyBaseline` everywhere (check / revert / record / the
interactive flow), so the tier is uniform across commands. It re-tags
matching `declared` / `undeclared` findings to `ignored` (never `deleted` — a path
rule must not silence a resource deletion; the already-informational tiers are left
alone). The `path` pattern globs (`*` / `?`) against EITHER `<logicalId>.<path>` OR
(when present) `<constructPath>.<path>`, so both styles work: the logicalId
(`ApiRole1234ABCD.Policies`) is the CloudFormation template's resource key — always
present, so rules work on ANY stack, **CDK or not** (raw CloudFormation / SAM); the
constructPath (`MyStack/ApiRole.Policies`) is the human-friendly id `cdk-local` also
targets by, offered as an additional match target (it comes from optional
`aws:cdk:path` Metadata, so it can't be the only key). A parent-segment rule
(`X.Policies`) covers child paths (`X.Policies.0.PolicyName`).
Ignored findings drop out of the revert plan and the record-set automatically
(neither acts on the `ignored` tier). A malformed `config.json` — invalid JSON,
a wrong-typed `ignore`, or an unknown top-level key (R62: a typo like `"ignroe"`
would otherwise load as an empty config and silently disable every rule) — fails
the run (exit 2) rather than silently dropping the rules. Applied even under `--show-all`
(inventory un-suppresses the baseline, not the ignore rules); `--verbose` still lists
the ignored entries. A CLI to manage rules (`cdkrd ignore <pattern>`) is a future
open question (§13) — v1 is hand-edited. **Default text layout (R25, spacing
R37/R48):** the three DRIFT tiers print in full; the INFORMATIONAL tiers are
folded into an `info:` footer (per-tier counts + a reason breakdown, e.g.
`skipped=24 (custom resource 12, override target unresolved 12)`) — a single
line when one tier is present, one bullet line per tier (with a single
`--verbose` hint) when 2+; `--verbose` expands them to full lists; 0-count
tiers are never printed. Section headers carry the count INSIDE the brackets
(`[CFn-Declared Drift: 3]`, the explanatory note outside) — a bare digit right of
`]` read as noise (R48). No blank line precedes the header; the FIRST drift
section follows the header directly, later sections get a grouping blank, and
`result:` gets a blank line before it ONLY when a drift section was printed —
the verdict must not read as a member of the section above it, while a CLEAN
stack with one informational tier stays exactly 3 lines (R48 revising R37).
The check loop puts one blank line between consecutive stack reports in a
multi-stack run. The `result:` line carries the
verdict + non-zero drift counts only (the informational breakdown lives on `info:`,
so the two never duplicate); `^result:` stays greppable, but the formal
machine-readable contract is `--json` (the `info:` footer may span lines). `--json`
is unaffected — it always carries every finding. A `Custom::*` resource is `skipped`
without any API call (note: `custom resource — no cloud-side model to read`).
**Undecided = UNRECORDED, not drift (R60, per VALUE since R62):** the baseline
ENTRY is the contract that defines undeclared drift; a value with no entry on a
never-snapshot-complete resource has nothing to violate (§8). `applyBaseline`
tags such findings `unrecorded` — on a no-baseline first run that is every
undeclared value, and after a cherry-pick record it is still every value the
user did not pick. They render as their own `[Potential Drift: N]` section (note:
`live-only and not yet in your .cdkrd baseline, so cdkrd can't tell whether it's
intended or an out-of-band change — Record to accept it, or Revert to
remove it`) alongside any real `[CFn-Undeclared Drift]` section, are excluded from the verdict and the
`--fail` exit. The `result:` "potential drift" count is every SHOWN live-only
value — top-level AND nested (the R96 fold was removed: a nested undeclared value
that survives the upstream atDefault/generated/KNOWN*DEFAULT_PATHS folds is a real
out-of-band setting, so it lists in `[Potential Drift]` like a top-level one). The
`(+ M nested live-only to record)` tail and the neutral "to record" verdict survive
in the code for a future re-fold but are inert in practice (M is 0). The "No
baseline yet — … Record them right from this `cdkrd check` prompt, or run `cdkrd
record`." preamble prints whenever any live-only value is shown.
When BOTH a drift section and a `[Potential Drift]` section print, a lone
`N drift(s)` verdict reads as a mismatch against the 2+ visible blocks, so the
line switches to a combined findings count —
`result: 3 findings — 1 drift (declared=1) + 2 potential drift` — keeping the red
drift verdict intact (R114);
single-category runs keep their plain `CLEAN` / `no confirmed drift` / `N drift(s)` verdict.
Declared and deleted drift still report and fail normally. The interactive after-report
prompt still fires for unrecorded values (`potential drift found (live-only, no
baseline yet) — what do you want to do?`) so "show them first" keeps its promise of a selective record.
R141: it ALSO fires when there is simply NO baseline file yet — even on a CLEAN stack
(`no .cdkrd baseline yet — record the current state as your baseline?`), so the day-1
baseline is established through `check`'s own flow (the chosen Record writes the initial
snapshot-complete baseline with zero undeclared entries) rather than a separate `cdkrd
record` step; once a baseline exists, a clean run prompts nothing. `availableActions`
offers `record` when there are undeclared/added findings OR (no baseline AND no drift).
In `--json` the findings keep `tier: "undeclared"` (the documented enum) plus
an `"unrecorded": true` field, and `drifted` excludes them. `--show-all`
ignores the recorded baseline — it lists EVERY current undeclared value with no
suppression — but still runs `applyBaseline(*, undefined)`, so those live-only
values are tagged `unrecorded`(Potential Drift), not mislabeled confirmed drift:`--show-all --fail`does not exit 1 on a fresh deploy nobody has touched. Only`--declared-only`truly bypasses`applyBaseline`(the undeclared tier is filtered
out first, so its removal pass would misread every recorded entry).
**Color (R43):** output is colorized via semantic helpers
([style.ts](../src/report/style.ts), picocolors) — green/red bold verdicts,
yellow undeclared tier, dim informational footers — ONLY when stdout is a real
TTY and`NO_COLOR`is unset. Piped / CI /`--json`output is byte-identical
plain text (the helpers are the identity), so the greppable invariant holds;`FORCE_COLOR` is deliberately ignored. The pure formatters (`formatFinding`'s
ids, `formatPlan`) stay plain; styling happens at the printing edge.

A declared **top-level write-only** property (e.g. an IAM Role's
`AssumeRolePolicyDocument`) is surfaced as a `readGap` (note: `write-only — cannot
be read back`) rather than silently dropped — honoring the "never silently dropped"
invariant. Nested write-only path stripping stays silent on purpose (too granular to
report meaningfully per path).

## 10. Synth integration

[src/synth/](../src/synth/) wraps `@aws-cdk/toolkit-lib` (same dep as cdk-local):
`synthApp()` returns per-stack `{stackName, region, template}` from
`cloudAssembly.stacksRecursively` (NOT `.stacks`, which is the top-level assembly
only — `stacksRecursively` descends into nested assemblies so stacks inside a CDK
`Stage` / CDK Pipelines are discovered, not silently skipped); `discoverStacks()`
feeds stack resolution. Used for: (a) stack resolution — cdkrd is CDK-only, so EVERY
invocation discovers the app's stacks (all / exact-name / glob all select among them;
R33), (b) construct-path display, (c) `--pre-deploy` (the synth template becomes the
declared source so `check` shows the declared drift the next `cdk deploy` would
overwrite). The drift comparison itself still reads each stack's deployed template +
live state from AWS — the app only decides which stacks are in scope.

## 11. Reuse from cdkd + the cross-repo relationship

`cdkrd` is a **separate repo** that copies low-coupling pure utilities from cdkd
(`drift-calculator`, `cc-api-strip`, CC-gap deny-list, a few SDK-override readers)
and adds what cdkd lacks (schema-strip, policy canonicalizer, desired-adapter,
baseline I/O, report, the fail-closed resolver). Same toolchain as cdk-local
(Vite+ `vp`, pnpm, tsgo, oxc, semantic-release).

The shared `drift-calculator` lineage means bugs can be bi-directional: the
tag-order + id-array-order false positives found here were **back-ported to cdkd**
(PR #802, merged, verified by the `drift-revert-vpc` real-AWS integ). The name↔ARN
and KMS-alias fixes are cdkrd-only because cdkd's baseline is an AWS snapshot
(ARN-vs-ARN), not a template.

## 12. Testing & evidence

<!-- Do not hardcode an exact test count here — it goes stale on every change.
     State an approximate floor and point to the command for the live number. -->

- **250+ unit tests** (Vitest — run `vp run test` for the current count), AWS SDK
  mocked with
  `aws-sdk-client-mock`. Coverage spans resolver (incl. GetAtt-via-live-attrs +
  fail-closed), all normalizers, classify (incl. the dogfood regression pairs),
  baseline, revert plan + apply-ops + writers + the interactive abort→exit mapping
  (`resolveInteractiveRevertExit`, R30), overrides incl. EIP, glob, cli-args,
  template-adapter incl. `--pre-deploy` override, report.
- **Golden corpus** (R63, [record.ts](../src/corpus/record.ts) +
  `tests/corpus-replay.test.ts`): the normalize→classify pipeline is pure, so a
  resource's classification is fully determined by (resolved declared, raw live
  model, schema info, opts). `CDKRD_CORPUS_DIR=<dir> cdkrd check ...` records
  those inputs + the produced findings per readable resource during a REAL
  gather; committed cases under `tests/corpus/` are replayed offline through
  `classifyResource` on every CI run and must reproduce the findings exactly.
  This converts every dogfood / integ run into permanent false-positive AND
  false-negative regression coverage without AWS access. Account ids are
  sanitized at record time (uniformly, so ARN-identity suppression replays);
  resource/stack NAMES are not — recordings are reviewed before committing,
  and cases from confidential stacks are never committed (integ fixtures use
  fictional names and are always safe). An intended behavior change updates a
  case's `expected` in the same PR, making the semantic change reviewable.
- **Integration fixtures** under `tests/integration/{basic,iam,lambda,revert}` (real
  CDK apps + `verify.sh`). The revert integ proves deploy → record → out-of-band
  change → check → `revert --yes` → CLEAN → AWS converged. The `basic` fixture also
  ships `verify-deleted-guards.sh`, which exercises the `deleted` tier (delete a
  resource out of band → reported + exit 1, not revertable) and the unrecorded
  `revert` guard (unrecorded values refused unless `--remove-unrecorded`).
- **Dogfood evidence**: 8 real cdkd fixtures run through `check --show-all` → fix →
  `declared=0`, then `record` → CLEAN, then destroy + orphan-verified. This is what
  surfaced the four false-positive classes.

## 13. Known limitations & open questions (review focus)

Things worth a reviewer's challenge before Phase 4:

1. **Lint (RESOLVED)**: `vp check` is now clean (0 errors, 7 warnings; CI `vp run
check` green). The earlier `TS2591 'process'` errors came from oxc's type-aware
   lint using the root `tsconfig.json` (which excludes tests) for test files; fixed by
   adding `tests/tsconfig.json` (oxc discovers the nearest per-file project), which
   includes the tests with node types. The 7 remaining are intentional `no-explicit-any`
   warnings (`Record<string, any>` in the template adapter) + `toThrow`-message vitest
   warnings — config sets `no-explicit-any` to `warn`, not `error`. _Open question for
   review: tighten these to errors before launch, or record as warnings?_
2. **`--pre-deploy` semantics (RESOLVED)**: pre-deploy now reports **declared-side
   tiers only** (declared / deleted / readGap / unresolved / skipped) and excludes
   undeclared entirely — the undeclared tier is "live minus declared", so with a
   _synth_ declared set its meaning silently shifts (a prop deleted from code would
   appear as undeclared). It also does NOT touch the baseline (no record offer, no
   hash check against the synth template). The question "what undeclared state do we
   record" is only meaningful against the deployed template, so it is answered by a
   normal `check`. pre-deploy answers exactly one question: what declared drift would
   the next `cdk deploy` clobber?
3. **`unresolved` residual (narrowed)**: the resolver now also handles `Fn::FindInMap`
   / `Fn::Split` / `Fn::ImportValue` / out-of-range `Fn::Select` / the `${!Literal}`
   Sub escape — all deterministically and fail-closed (answer to the original open
   question: keep the focused, fail-closed resolver and add only intrinsics we can
   resolve with certainty, rather than adopting cdkd's full resolver). Truly exotic
   intrinsics still skip honestly. **Residual open question**: is the remaining
   long-tail worth more, or is "report it as unresolved" the right stopping point?
4. **Single-region per invocation**; cross-region stacks handled per-stack via env.
   Cross-stack `Fn::ImportValue` IS now resolved (exports prefetched per region; see
   §5). Two notes for review: the per-region exports cache is module-level (fine for a
   one-shot CLI; revisit if cdkrd ever runs as a long-lived / multi-account process),
   and the prefetch trigger is a substring check on the template body
   (`includes('Fn::ImportValue')`) — a YAML `!ImportValue` shorthand would need the
   same trigger if YAML resolution ever diverges from the JSON-normalized body.
5. **Not-revertable types** (Lambda Permission, Budgets) — documented; revisit if
   demand appears.
6. **YAML templates**: parsed (`yaml-cfn.ts`), but the dogfooding was JSON (CDK
   output). Worth a YAML-template pass.
7. **Governance / repo hygiene (in place)**: CI (`.github/workflows/ci.yml` =
   `vp run check` + test + build; `release.yml` semantic-release; `pr-title-check.yml`),
   `.markgate.yml` (check/docs/verify-pr), `.claude/skills/{check,check-docs,verify-pr}`,
   `.claude/hooks/check-gate.sh` (+ `.claude/settings.json`), `CLAUDE.md`,
   `CONTRIBUTING.md`. Deliberately deferred until the repo has a remote (Phase 4):
   branch/PR/merge gates and `.claude/rules` / `.claude/agents` — cdkd's heavy
   50-hook / 10-rule suite is disproportionate for a new repo. _Open question: which
   of those become worth adding once there are external contributors?_
8. **Ignore-rule management (R32)**: ignore rules are hand-edited in
   `.cdkrd/config.json` for v1. _Open question: add a `cdkrd ignore <pattern>` /
   `cdkrd ignore --list` CLI to add/inspect rules without hand-editing JSON, once
   real usage shows the editing friction is worth it?_

## 14. Phase 4 readiness

DONE: Phase 2 (MVP) + Phase 3 (broad dogfood, normalizer tuning, revert landed,
GetAtt resolution, wildcard, EIP, ManagedPolicy revert, `--pre-deploy`, governance
skills, **lint clean / CI green**) + the **design-review fix pass (R1–R17)**:
out-of-band deletion as a first-class `deleted` tier, baseline-absent revert guard,
per-account baseline, create-only revert guard, promotion-into-template suppression,
baseline-value re-canonicalization, large-stack `ListStackResources` + concurrent
reads, more fail-closed intrinsics (FindInMap / Split / ImportValue / Select-OOB /
`${!Literal}`), strict managed-KMS-alias resolution, account/region-scoped ARN
identity, write-only `readGap` surfacing, real Lambda-Permission values,
declared-only `--pre-deploy`, and selective `record`.

Repo hygiene (CLAUDE.md, CONTRIBUTING.md, check-gate hook, CI) is in place too.

REMAINING before the single public launch (GitHub + npm + blog), none of which is a
code-correctness blocker:

- the design-review re-review of this fix pass → address any blocking findings.
- create the public GitHub repo + push, then `npm publish`, then the blog announce.
  These three are the deliberate, irreversible "single launch" event and are done
  last, on explicit go.

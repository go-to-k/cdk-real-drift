<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

### 3. Deploy (parallel, capped) + check

Run the `verify.sh` set in parallel (≤3–4). Each `verify.sh` MUST have a cleanup
`trap` that runs `delstack cdk -a cdk.out -r "$REGION" -f -y` (NOT `cdk destroy` —
see CLAUDE.md) on EXIT, so even a failed run deletes its stack. Triage every
`result:` that is not CLEAN, and scan the `info:` footer: a `skipped=` on a COMMON
type is a read-gap many users hit (an SDK-override candidate); an `unresolved=`
points at declared values whose intrinsics cdkrd couldn't resolve.

### 4. Test detection (the FN half)

For at least one common type, mutate a declared MUTABLE property out of band and
assert `check` detects → `revert` → `check` CLEAN → live value restored
(`lambda-rich/verify-detect.sh` is the reference).

**When your FP fix ADDS a `KNOWN_DEFAULTS` fold for a MUTABLE prop AWS assigns,
live-test the REVERT of that value too — not just detection.** Mutate the folded
prop to a NON-default (it must re-surface, proving the equality-gate still detects an
out-of-band change), then `revert` and confirm the live value actually returns to the
default. Some providers IGNORE an omitted property on update, so the default `remove`
revert is a SILENT no-op — Cloud Control reports SUCCESS yet the live value persists
(observed on Transfer `UpdateServer` / `SecurityPolicyName` go-to-k/cdk-real-drift#597, IAM
`MaxSessionDuration`, Lambda Alias `Description`, Cognito `AllowClassicFlow`). The fix
is to add `${resourceType}\0${path}` to `REVERT_SET_DEFAULT_PATHS`
(`src/revert/plan.ts`) so revert writes the `KNOWN_DEFAULTS` default EXPLICITLY and
converges — otherwise you ship a revert that claims success but leaves the value
unchanged.

**The revert-no-op class is NON-UNIFORM — a dedicated-toggle-API does NOT imply a
no-op; live-prove EACH candidate, never predict from the API shape.** It is tempting
to assume that a property changed only by a dedicated sub-API (Enable/DisableRule,
Increase/DecreaseStreamRetentionPeriod, PutBackupPolicy, SetQueueAttributes) must
no-op on an omitted `remove` — but the Cloud Control HANDLER often RECONCILES the full
desired state and resets the property to its default when omitted. Live-proven
2026-07-13 (go-to-k/cdk-real-drift#1571): of four dedicated-toggle siblings, only **`Kinesis::Stream`
`RetentionPeriodHours`** actually no-oped (CC leaves it unchanged) and needed the RSDP
entry; **`Events::Rule` State, `SQS::Queue` VisibilityTimeout, `EFS::FileSystem`
BackupPolicy all CONVERGED via the bare `remove`** (the CC handler reset them). So a
cheap combined fixture (several folded toggles in one stack) that mutates each out of
band and asserts the LIVE value after revert is the only reliable test — the API shape
is not a predictor. The `revert-toggle-converge` fixture is the reference (one fixed
case + converge-via-remove controls). Batch 2 (2026-07-14, `revconv-hunt` fixture):
**`ECR::Repository` `ImageTagMutability` no-oped** (independently found+fixed the
same day as go-to-k/cdk-real-drift#1580 / go-to-k/cdk-real-drift#1581 — check upstream before pushing a same-table fix); Lambda
`TracingConfig`, SQS `DelaySeconds`, KMS Key `Enabled` all converged via bare
`remove` — again ~1-in-4, unpredictable from the API shape. Batch 3 (2026-07-14,
`revconv2-hunt` fixture): **`ECR::Repository` `ImageScanningConfiguration` no-oped**
(the ImageTagMutability sibling — same partial-update contract); DDB
`PointInTimeRecoverySpecification`, S3 `VersioningConfiguration` (the handler
actually SUSPENDS on omitted — S3 can never return to never-versioned), LogGroup
`RetentionInDays`, EventBus `LogConfig`, Kinesis `StreamModeDetails`
(ON_DEMAND→PROVISIONED via remove) all converged. The no-op contract is non-uniform
even WITHIN a type: ECR's `RepositoryPolicyText` / `LifecyclePolicy` removes DO
converge (both policies live-deleted), so the ECR gap is exactly the two
scan/mutability scalars — prove per-property, not per-type. Also excluded from any
in-run revert probe by AWS-side rate limits (not cdkrd bugs): DDB TTL (1 change/h),
EFS ThroughputMode (1 change/24h); Kinesis stream-mode allows exactly 2 switches/24h
— enough for one mutate + one revert, none left for a retry. Batch 4 (2026-07-14,
`revconv3-hunt` fixture, go-to-k/cdk-real-drift#1613): **SQS `SqsManagedSseEnabled`** (its 4 scalar
siblings converge — non-uniform WITHIN SQS again), **SFN `LoggingConfiguration`**,
**ApiGateway RestApi `DisableExecuteApiEndpoint`**, **Cognito UserPoolClient
`RefreshTokenValidity`** all no-oped; Athena WorkGroup `State`, DDB
`DeletionProtectionEnabled`, Scheduler Schedule `State` converged via the bare
`remove` — ~1-in-2 this round. Excluded as SERVER-SIDE IRREVERSIBLE (not a
convergence probe): SSM Parameter `Tier` (AWS cannot downgrade Advanced→Standard).
Batch 5 (2026-07-14, `revconv4-hunt` fixture, go-to-k/cdk-real-drift#1619): **ECS Cluster
`ClusterSettings`**, **ApiGateway RestApi `ApiKeySourceType`**, **Glue Crawler
`SchemaChangePolicy`** no-oped (RSDP entries converge them); CW Alarm
`TreatMissingData`, AppSync `IntrospectionConfig`, Scheduler
`ScheduleExpressionTimezone`, Pipes `DesiredState` converged — ~1-in-2 again. And a
THIRD class appeared: **CloudWatch CompositeAlarm `ActionsEnabled`** no-ops even an
EXPLICIT `add /ActionsEnabled true` CC patch (SUCCESS reported, value unchanged), so
an RSDP set-default CANNOT converge it — the fix is an `SDK_PROP_WRITERS` entry
driving the dedicated Enable/DisableAlarmActions API. **Probe that class for free
before writing the fix: `aws cloudcontrol update-resource --patch-document
'[{"op":"add","path":"/X","value":<default>}]'` against a CLI-created resource
answers "does the explicit write converge?" with no stack.** Also found: CodeBuild
Project + MediaConvert Queue detect fine but are read-only ("type not revertable
yet") — when a probe target is such a type, restore it OUT OF BAND before `revert`
or the fixture can never converge to zero (go-to-k/cdk-real-drift#1623). Batch 6 (2026-07-14, barest4/ccpi
hunt): **RUM AppMonitor `CustomEvents`** no-oped (silent keep), and **ServiceCatalog
TagOption `Active`** surfaced a FOURTH flavor — the handler REJECTS the bare remove
outright (`InvalidRequest: Active and new value cannot both be null`), a hard error
instead of a silent no-op; both fixed by RSDP entries. Batch 7 (2026-07-14,
`revconv5-hunt` fixture): Lambda `RecursiveLoop` + `RuntimeManagementConfig`, HTTP-API
`DisableExecuteApiEndpoint`, SES ConfigurationSet `SendingOptions`/`ReputationOptions`,
KinesisVideo `DataRetentionInHours`, CloudTrail `EventSelectors`, and S3
`PublicAccessBlockConfiguration` ALL converged via the bare `remove` (0-in-8 no-op —
the class has streaks; keep probing anyway, batches 4-5 were ~1-in-2). The batch's
real payoff was the DETECTION side — see the all-boolean-object off-flip gotcha.
Batch 8 (2026-07-15, misspack/lattice2/attach2 hunt, probed as piggybacks on that
hunt's NEW folds rather than a dedicated fixture): **VpcLattice ResourceConfiguration
`AllowAssociationToSharableServiceNetwork`**, **Backup RestoreTestingPlan
`StartWindowHours` AND `ScheduleExpressionTimezone`** (same handler, both proven
individually), and **EC2 TransitGatewayAttachment `Options`** ALL no-oped — 4-in-4
for this batch's new folds (streaks run hot too); every one converged via an explicit
CC `add` patch → plain RSDP entries (go-to-k/cdk-real-drift#1639 / go-to-k/cdk-real-drift#1640 / go-to-k/cdk-real-drift#1642).
Batch 9 (2026-07-22 hunt): **RUM `AppMonitorConfiguration`** (go-to-k/cdk-real-drift#1684, sibling of
CustomEvents), **GuardDuty Filter `Action`** (go-to-k/cdk-real-drift#1687), and **Cognito UserPoolClient
`EnableTokenRevocation` + `AuthSessionValidity`** (go-to-k/cdk-real-drift#1689 — the RefreshTokenValidity
siblings, both proven by a STACKLESS CC probe: `cloudcontrol create-resource`
pool+client, OOB-flip, bare `remove` no-ops, explicit `add` converges — the whole
per-property proof for ~$0 and no fixture) all no-oped → RSDP entries; Backup RTP
`RecoveryPointSelection.SelectionWindowDays`, Lambda ESM `ParallelizationFactor`, and
ECS Service `AssignPublicIp` converged (no entries needed).
Batch 10 (2026-08-01 hunt) settled most of batch 9's deferred list for ~$0: **GuardDuty
`ThreatEntitySet` + `TrustedEntitySet` `ExpectedBucketOwner` BOTH no-oped** (proven
individually via stackless CC probes; the OOB API accepts a FOREIGN account id on an
INACTIVE set — an ACTIVE set validates against the real bucket owner and rejects it
with AccessDeniedException, so an E2E fixture leg must target an Activate:false set —
the drift is real and security-typed) — and exposed a STRUCTURAL gap:
the pin lives in `CONTEXT_ARN_DEFAULTS` (`{accountId}` placeholder), which
plan.ts did not consult at all, so no plain RSDP entry could express the fix. go-to-k/cdk-real-drift#1694
adds RSDP entries + an `opts.identity`-resolved `contextArnDefaultFor` fallback in
`revertOp` — any future CONTEXT_ARN_DEFAULTS pin gets revert convergence by adding
the RSDP key alone. **Lambda ESM `TumblingWindowInSeconds` CONVERGED** via the bare
`remove` (like PF) — but ONLY when the probe patch rides the
`/DestinationConfig/OnFailure` husk removal (`CC_UPDATE_REJECTED_EMPTY_PATHS`,
go-to-k/cdk-real-drift#1611): a raw stackless probe WITHOUT the husk op fails with "The Destination field
is required" and proves nothing — when a stackless CC probe errors, check the type's
husk table entry before concluding anything. **VpcLattice ALS
`ServiceNetworkLogType` closed offline** (update API takes only destination-arn —
not OOB-mutable, in-code note). **SES `ScalingMode` closed from docs**
(MANAGED→STANDARD is unsupported by the service — detect-only forever, no probe can
help; in-code note). **Remaining deferred candidates**: OpenSearch
`ClusterConfig.DedicatedMasterCount` (HIGH cost, and NOTE: it is a NESTED
KNOWN_DEFAULT_PATHS pin, so plan.ts already emits an explicit `add` — the residual
risk is only the go-to-k/cdk-real-drift#763 explicit-write-ignored class, low), EC2 VPCEndpointService
`SupportedIpAddressTypes` (needs a dualstack NLB in IPv6 subnets), Synthetics Canary
`Schedule.DurationInSeconds` + Firehose `HttpEndpointDestinationConfiguration.*`
(nested pins — same auto-`add` note as OpenSearch, low residual).
Batch 11 (2026-08-02 hunt, go-to-k/cdk-real-drift#1709 / go-to-k/cdk-real-drift#1710) found the CLASS behind several of these:
**DERIVED (tier-2) folds had NO revert-side value source at all** — classify builds
them into its LOCAL knownDef/knownDefPaths, so the RSDP branch sourced the (wrong)
static value and the nested explicit-`add` branch missed entirely. Live-proven:
Route53 HealthCheck `HealthCheckConfig.Port` (derived 80/443) bare-remove no-oped;
ELBv2 TG `HealthCheckProtocol` no-oped on BOTH the GENEVE and HTTPS arms; an RDS
READ-REPLICA's `BackupRetentionPeriod` reverted to the static 1 instead of the
derived 0 (a wrong-value revert that silently enables backups). Fixed generally:
`derivedRevertDefaultFor` (plan.ts) derives through the SHARED
`normalize/derived-defaults.ts` helpers — **every future derived fold must add its
resolver arm there + a stackless convergence probe, or its revert is a silent
no-op/wrong-value by construction.** The same batch surfaced a FIFTH revert-no-op
flavor: the explicit default write is REJECTED while an incompatible sibling echo
remains in the CC read-modify-write model (TG back-to-TCP with the L7
`Matcher`/`HealthCheckPath` present — "matchers are not supported for TCP"; Volume
back-to-gp2 with the gp3 `Iops`/`Throughput` echoes — "iops is not supported for
gp2"). Fix = `REVERT_COMPANION_REMOVES` (plan.ts): sibling `remove`s ride the same
patch, gated on live-presence + not-declared; both combined patches live-converged.
Cassandra Table `DefaultTimeToLive` CONVERGED via bare remove (no entry needed).
Batch 12 (2026-08-03 hunt): **CodeDeploy DeploymentGroup `DeploymentConfigName`
no-oped** (the go-to-k/cdk-real-drift#1723 fold's revert side; explicit CC `add` converged → RSDP entry,
go-to-k/cdk-real-drift#1725) — probed by piggybacking on the enum-added2 stack the same day the fold
shipped, exactly the piggyback rule below. Its sibling `DeploymentStyle` whole-object
pin stays revert-unproven: the off-default shape is UNREACHABLE on a barest Server
DG (UpdateDeploymentGroup rejects WITH_TRAFFIC_CONTROL without LoadBalancerInfo) —
an LB-attached fixture would be needed. And a REVERT-DELETE flavor: an `added`
**AWS::Glue::Table** delete-kind item failed at apply with UnsupportedActionException
(CC has no DELETE handler — the go-to-k/cdk-real-drift#1405 class, but with a trivial service API) → fixed
as an `SDK_DELETERS` entry splitting the enumerator identifier `db|table` (go-to-k/cdk-real-drift#1724);
when an added-child revert fails this way, prefer the go-to-k/cdk-real-drift#1431 SDK-deleter route over
the honest-notRevertable set whenever the service has a one-call delete.
Batch 13 (2026-08-10 hunt, the "writer-proof pack"): the Round-0 offline audit found
the READ side fully corpus-exercised but ~10 SDK writers/deleters that had NEVER run
live — one nearly-free stack (`wrtpack-hunt`) mutate→detect→revert→live-assert'd all
of them at once and found THREE revert bugs in one run: **Budgets `writeBudget`
crashed on a template-declared NUMERIC `BudgetLimit.Amount`** (the CFn schema allows
a number, the API models Spend.Amount as a STRING → SerializationException; go-to-k/cdk-real-drift#1744 —
when writing a writer, check every CFn-numeric/API-string field, the Spend shape
recurs); **an UNDECLARED ELB attribute-bag element (`TargetGroupAttributes[key]`)
was pre-barred by the generic nested-array-element gate** before the per-key prop
writer could take it (go-to-k/cdk-real-drift#1745 — when a "not revertable" reason fires on a path a
writer COULD serve, check the bar's ordering before accepting it); and **ECS DAEMON
`DeploymentConfiguration` remove was REJECTED outright** because the CC
read-modify-write model still carried the ECS-managed `DesiredCount` echo ("daemon
scheduling strategy does not support a desired count") — the go-to-k/cdk-real-drift#1710
companion-removes flavor, fixed with a derived whole-object explicit `add` + an
`AWS::ECS::Service\0DeploymentConfiguration` companion entry (go-to-k/cdk-real-drift#1740). The audit
shape ("which writers have zero live evidence?") is repeatable and cheap — re-run it
whenever a few new writers have accumulated.
Batch 14 (2026-08-11 hunt): a SIXTH revert-no-op flavor — **GuardDuty Detector
rejects EVERY CC patch** on a current-era detector: the model echo carries BOTH the
deprecated `EKS_RUNTIME_MONITORING` and successor `RUNTIME_MONITORING` features
("cannot be provided in the same request"), and separately DataSources+Features may
not coexist in one update ("provide only one") — so even a patch touching NEITHER
fails. Fix shape (go-to-k/cdk-real-drift#1752, all legs live-proven stackless): TRANSLATE any
`/DataSources/*` op to the successor-API side (`/Features/<idx>/Status`), companion-
remove `/DataSources` (a derived projection — dropping it from the WRITE model is
not a state change), companion-remove the deprecated feature element LAST (index
stability). When a type carries a deprecated/successor API-alias pair in one model,
expect this class. Same batch: ServerlessCache `Description` bare-remove silently
no-ops (RSDP `' '` one-space placeholder converges, go-to-k/cdk-real-drift#1753); Transfer `Protocols` is
OOB-UNREACHABLE on the barest form (UpdateServer rejects FTP/FTPS "unsupported for
IdentityProviderType SERVICE_MANAGED", 2026-08-11 — a barest server can never drift
its protocols, so that pin's revert convergence is moot; an API_GATEWAY-idp server
could, left unproven). A stackless Transfer probe artifact worth knowing: CC
UpdateResource on a tagless Transfer Server fails model validation ("#/Tags:
expected minimum item count: 1") — tag the probe resource or expect the reject. Deferred convergence candidates (unproven, from the plan.ts
audit — probe when their infra is cheap to stand up): ELBv2 Listener
`MutualAuthentication.AdvertiseTrustStoreCaNames` (go-to-k/cdk-real-drift#1698, needs mTLS listener),
ImageBuilder `ImageTestsConfiguration.*` (go-to-k/cdk-real-drift#1702, needs recipe+infra chain), ASG
`MixedInstancesPolicy.InstancesDistribution` (go-to-k/cdk-real-drift#1695, needs MIP ASG), CloudFront
VpcOrigin `OriginSSLProtocols` (go-to-k/cdk-real-drift#1734, needs VPC-origin infra), AppSync DataSource
`MetricsConfig` + SourceApiAssociation config (go-to-k/cdk-real-drift#1751, needs API+schema+DS chain).
Piggyback the convergence
probe on every NEW KNOWN_DEFAULTS fold a hunt ships (mutate → revert → re-read) —
it is ~1-in-3 to need an RSDP entry, and the probe is nearly free while the stack
is still up. When the resource is CC-creatable, the batch-9 stackless form (create
via `cloudcontrol create-resource`, OOB-mutate, bare-`remove` probe, explicit-`add`
probe, delete) proves a candidate with NO stack and NO fixture — prefer it for
per-property proofs of already-folded defaults.

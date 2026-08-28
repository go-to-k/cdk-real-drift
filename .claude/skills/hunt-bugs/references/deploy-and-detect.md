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
live-test the REVERT of that value too — not just detection.** Mutate the folded prop
to a NON-default (it must re-surface — the equality-gate still detects), `revert`,
confirm the live value actually returns. Some providers IGNORE an omitted property on
update: the default `remove` revert is a SILENT no-op — CC reports SUCCESS, the live
value persists (Transfer `SecurityPolicyName` go-to-k/cdk-real-drift#597; IAM
`MaxSessionDuration`; Lambda Alias `Description`; Cognito `AllowClassicFlow`). Fix:
add `${resourceType}\0${path}` to `REVERT_SET_DEFAULT_PATHS` (RSDP,
`src/revert/plan.ts`) so revert writes the default EXPLICITLY and converges.

**The revert-no-op class is NON-UNIFORM — a dedicated-toggle-API does NOT imply a
no-op; live-prove EACH candidate, never predict from the API shape.** CC handlers
often RECONCILE full desired state and reset an omitted property (2026-07-13,
go-to-k/cdk-real-drift#1571: of four dedicated-toggle siblings only Kinesis
`RetentionPeriodHours` no-oped). Non-uniform even WITHIN a type: ECR's
`RepositoryPolicyText` / `LifecyclePolicy` removes DO converge while its
`ImageTagMutability` / `ImageScanningConfiguration` scalars no-op — prove
per-property, not per-type. Batch hit rates ran 0-in-8 to 4-in-4 (~1-in-3 overall) —
streaks run hot and cold; keep probing anyway. Reference fixture:
`revert-toggle-converge` (one fixed case + converge-via-remove controls).

**Probe methods (cheapest first):**

- **Stackless CC probe** (when the resource is CC-creatable): `cloudcontrol
create-resource` → OOB-mutate → bare-`remove` probe → explicit-`add` probe → delete.
  The whole per-property proof for ~$0, no fixture (go-to-k/cdk-real-drift#1689).
  Prefer it for already-folded defaults.
- **Explicit-write probe before writing a fix:**

  ```sh
  aws cloudcontrol update-resource --patch-document '[{"op":"add","path":"/X","value":<default>}]'
  ```

  against a CLI-created resource answers "does the explicit write converge?" with no stack.

- **Piggyback** the probe (mutate → revert → re-read) on every NEW `KNOWN_DEFAULTS`
  fold a hunt ships, while the stack is still up — nearly free (CodeDeploy
  `DeploymentConfigName`, go-to-k/cdk-real-drift#1723 / go-to-k/cdk-real-drift#1725).
- **A stackless probe that ERRORS proves nothing until you check the type's
  husk-table entry** (`CC_UPDATE_REJECTED_EMPTY_PATHS`, go-to-k/cdk-real-drift#1611):
  Lambda ESM `TumblingWindowInSeconds` failed raw ("The Destination field is
  required") and only proved convergent with the `/DestinationConfig/OnFailure` husk
  removal riding the patch.
- **Read-only probe targets** ("type not revertable yet" — CodeBuild Project,
  MediaConvert Queue): restore OUT OF BAND before `revert` or the fixture can never
  converge to zero (go-to-k/cdk-real-drift#1623).
- **Check upstream before pushing a same-table fix** — ECR `ImageTagMutability` was
  independently found+fixed the same day as go-to-k/cdk-real-drift#1580 /
  go-to-k/cdk-real-drift#1581.

**Revert-failure flavors and their fixes** (each live-proven; expect new ones):

1. **Silent bare-remove no-op** → RSDP entry (the base class). ServerlessCache
   `Description` needs an RSDP `' '` one-space placeholder
   (go-to-k/cdk-real-drift#1753).
2. **Explicit `add` ALSO no-ops** — CompositeAlarm `ActionsEnabled` ignores even an
   explicit `add` (SUCCESS, value unchanged); RSDP cannot converge it — fix =
   `SDK_PROP_WRITERS` entry driving the dedicated API (go-to-k/cdk-real-drift#1619).
3. **Handler REJECTS the bare remove** — hard error, not silent (ServiceCatalog
   TagOption `Active`: "Active and new value cannot both be null"); still an RSDP fix.
4. **Explicit default REJECTED while an incompatible sibling echo remains** in the CC
   read-modify-write model (TG back-to-TCP with L7 `Matcher`/`HealthCheckPath` —
   "matchers are not supported for TCP"; Volume back-to-gp2 with gp3
   `Iops`/`Throughput` echoes — "iops is not supported for gp2") — fix = `REVERT_COMPANION_REMOVES` (plan.ts): sibling
   `remove`s ride the same patch, gated on live-presence + not-declared
   (go-to-k/cdk-real-drift#1709 / go-to-k/cdk-real-drift#1710). Same flavor: ECS
   DAEMON `DeploymentConfiguration` ("daemon scheduling strategy does not support a
   desired count") — derived whole-object explicit `add` + an
   `AWS::ECS::Service\0DeploymentConfiguration` companion entry
   (go-to-k/cdk-real-drift#1740).
5. **Type rejects EVERY CC patch** via a deprecated/successor API-alias pair in one
   model — GuardDuty Detector echoes BOTH `EKS_RUNTIME_MONITORING` and
   `RUNTIME_MONITORING` ("cannot be provided in the same request") and
   DataSources+Features may not coexist in one update ("provide only one"), so
   even a patch touching NEITHER fails. Fix
   (go-to-k/cdk-real-drift#1752, all legs proven stackless): TRANSLATE
   `/DataSources/*` ops to the successor side (`/Features/<idx>/Status`),
   companion-remove `/DataSources` (a derived projection, not a state change),
   companion-remove the deprecated element LAST (index stability). Expect this class
   on any model carrying such a pair.
6. **DERIVED (tier-2) folds had NO revert-side value source** — classify builds them
   into LOCAL knownDef/knownDefPaths, so RSDP sourced the (wrong) static value and the
   nested explicit-`add` branch missed (Route53 HealthCheck `HealthCheckConfig.Port`;
   ELBv2 TG `HealthCheckProtocol`, both GENEVE and HTTPS arms; an RDS READ-REPLICA's
   `BackupRetentionPeriod` reverted to static 1 instead of derived 0 — silently
   enabling backups). General fix: `derivedRevertDefaultFor` (plan.ts) derives through
   the SHARED `normalize/derived-defaults.ts` helpers — **every future derived fold
   must add its resolver arm there + a stackless convergence probe, or its revert is a
   silent no-op/wrong-value by construction.**
7. **Revert-DELETE failure** — an `added` child's delete fails with
   UnsupportedActionException (no CC DELETE handler, the go-to-k/cdk-real-drift#1405
   class). When the service has a one-call delete, prefer the
   go-to-k/cdk-real-drift#1431 SDK-deleter route over honest-notRevertable: Glue Table
   → `SDK_DELETERS` entry splitting the enumerator identifier `db|table`
   (go-to-k/cdk-real-drift#1724).
8. **`CONTEXT_ARN_DEFAULTS` pins had no revert path** — plan.ts never consulted that
   table (`{accountId}` placeholder), so no RSDP entry could express the fix;
   go-to-k/cdk-real-drift#1694 adds an `opts.identity`-resolved
   `contextArnDefaultFor` fallback in `revertOp` — any future such pin converges by
   adding the RSDP key alone. Found via GuardDuty `ThreatEntitySet` +
   `TrustedEntitySet` `ExpectedBucketOwner` (both no-oped, proven stackless); the
   OOB API accepts a FOREIGN account id only on an INACTIVE set (an ACTIVE one
   rejects with AccessDeniedException), so an E2E leg must target an
   `Activate:false` set — the drift is real and security-typed.

**Live-proven ledger** (no-oped → entry shipped; converged → bare `remove` suffices):

- No-oped → RSDP entries: Kinesis `RetentionPeriodHours`
  (go-to-k/cdk-real-drift#1571); ECR `ImageTagMutability` + `ImageScanningConfiguration`;
  SQS `SqsManagedSseEnabled`, SFN `LoggingConfiguration`, ApiGateway RestApi
  `DisableExecuteApiEndpoint`, Cognito UserPoolClient `RefreshTokenValidity`
  (go-to-k/cdk-real-drift#1613); ECS Cluster `ClusterSettings`, ApiGateway RestApi
  `ApiKeySourceType`, Glue Crawler `SchemaChangePolicy` (go-to-k/cdk-real-drift#1619);
  RUM AppMonitor `CustomEvents` + `AppMonitorConfiguration`
  (go-to-k/cdk-real-drift#1684); GuardDuty Filter `Action`
  (go-to-k/cdk-real-drift#1687); Cognito UserPoolClient `EnableTokenRevocation` +
  `AuthSessionValidity` (go-to-k/cdk-real-drift#1689); VpcLattice
  ResourceConfiguration `AllowAssociationToSharableServiceNetwork`, Backup
  RestoreTestingPlan `StartWindowHours` + `ScheduleExpressionTimezone` (same handler,
  proven individually), EC2 TransitGatewayAttachment `Options`
  (go-to-k/cdk-real-drift#1639 / go-to-k/cdk-real-drift#1640 /
  go-to-k/cdk-real-drift#1642).
- Converged (no entry): Events::Rule `State`; SQS `VisibilityTimeout` +
  `DelaySeconds`; EFS `BackupPolicy`; Lambda `TracingConfig` + `RecursiveLoop` +
  `RuntimeManagementConfig`; KMS Key `Enabled`; DDB
  `PointInTimeRecoverySpecification` + `DeletionProtectionEnabled`; LogGroup
  `RetentionInDays`; EventBus `LogConfig`;
  Kinesis `StreamModeDetails` (ON_DEMAND→PROVISIONED via remove); Athena WorkGroup
  `State`; Scheduler Schedule `State` + `ScheduleExpressionTimezone`; CW Alarm
  `TreatMissingData`; AppSync `IntrospectionConfig`; Pipes `DesiredState`; HTTP-API
  `DisableExecuteApiEndpoint`; SES ConfigurationSet
  `SendingOptions`/`ReputationOptions`; KinesisVideo `DataRetentionInHours`;
  CloudTrail `EventSelectors`; S3 `PublicAccessBlockConfiguration`; Backup RTP
  `RecoveryPointSelection.SelectionWindowDays`; Lambda ESM `ParallelizationFactor` +
  `TumblingWindowInSeconds`; ECS Service `AssignPublicIp`; Cassandra Table
  `DefaultTimeToLive`. NOTE: S3 `VersioningConfiguration` "converges" by SUSPENDING —
  S3 can never return to never-versioned.
- Excluded by AWS-side rate limits (not cdkrd bugs): DDB TTL (1 change/h), EFS
  ThroughputMode (1 change/24h), Kinesis stream-mode (exactly 2 switches/24h — one
  mutate + one revert, none left for a retry).
- Server-side irreversible / unreachable: SSM Parameter `Tier` (no Advanced→Standard
  downgrade); Transfer `Protocols` OOB-unreachable on the barest form (UpdateServer
  rejects FTP/FTPS under SERVICE_MANAGED idp, 2026-08-11 — an API_GATEWAY-idp server
  could drift it, unproven); CodeDeploy `DeploymentStyle` whole-object pin
  (WITH_TRAFFIC_CONTROL rejected without LoadBalancerInfo on a barest Server DG);
  VpcLattice ALS `ServiceNetworkLogType` (update API takes only destination-arn —
  in-code note); SES `ScalingMode` (MANAGED→STANDARD unsupported — detect-only
  forever, in-code note).
- Stackless-probe artifact: CC UpdateResource on a tagless Transfer Server fails
  model validation ("#/Tags: expected minimum item count: 1") — tag the probe
  resource or expect the reject.
- Deferred (unproven — probe when the infra is cheap): ELBv2 Listener
  `MutualAuthentication.AdvertiseTrustStoreCaNames` (go-to-k/cdk-real-drift#1698,
  mTLS listener); ImageBuilder `ImageTestsConfiguration.*`
  (go-to-k/cdk-real-drift#1702, recipe+infra chain); ASG
  `MixedInstancesPolicy.InstancesDistribution` (go-to-k/cdk-real-drift#1695); CloudFront
  VpcOrigin `OriginSSLProtocols` (go-to-k/cdk-real-drift#1734); AppSync DataSource
  `MetricsConfig` + SourceApiAssociation config (go-to-k/cdk-real-drift#1751); EC2
  VPCEndpointService `SupportedIpAddressTypes` (dualstack NLB in IPv6 subnets);
  OpenSearch `ClusterConfig.DedicatedMasterCount`, Synthetics Canary
  `Schedule.DurationInSeconds`, Firehose `HttpEndpointDestinationConfiguration.*`
  (nested `KNOWN_DEFAULT_PATHS` pins — plan.ts already emits an explicit `add`;
  residual risk is only the go-to-k/cdk-real-drift#763 explicit-write-ignored class,
  low).

**Writer audit** (2026-08-10, `wrtpack-hunt`): ask "which SDK writers/deleters have
ZERO live evidence?" and mutate→detect→revert→live-assert them all on one nearly-free
stack — repeatable and cheap; re-run whenever a few new writers accumulate. One run
found three revert bugs: check every CFn-numeric/API-string field when writing a
writer (Budgets `writeBudget` crashed on a NUMERIC `BudgetLimit.Amount` — the API
models Spend.Amount as a STRING → SerializationException, go-to-k/cdk-real-drift#1744;
the Spend shape recurs); when a "not revertable" reason fires on a path a writer
COULD serve, check the bar's ORDERING (undeclared `TargetGroupAttributes[key]`
pre-barred by the generic nested-array-element gate, go-to-k/cdk-real-drift#1745);
and the ECS DAEMON case in flavor 4 (go-to-k/cdk-real-drift#1740).

// Undeclared-property noise suppressors (slice fixes A1/A2/A4).
// Keep conservative — over-suppression hides real undeclared drift.

// A4: defaults AWS applies that are NOT in the CFn schema's `default` field.
// Every entry is equality-gated: it only suppresses a live value EQUAL to the
// listed default, so an out-of-band change to anything else still surfaces (and
// a recorded baseline value that flips back to the default is still drift —
// the entry only mutes the never-declared/never-decided first sighting). R66
// entries were all OBSERVED on real default-config stacks during dogfooding.
export const KNOWN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'AWS::IAM::Role': { MaxSessionDuration: 3600, Path: '/', Description: '' },
  // S3 versioning can never return to the never-enabled state — a revert "remove"
  // lands on Suspended, which IS the off state. Without this entry an undeclared
  // {Status:"Suspended"} re-reports forever and revert can never converge (R46).
  'AWS::S3::Bucket': {
    VersioningConfiguration: { Status: 'Suspended' },
    AbacStatus: 'Disabled', // R66
    // R86 (account-wide S3 defaults AWS has applied to every new bucket since 2023):
    // Block Public Access fully on (Apr 2023), ACLs disabled / BucketOwnerEnforced
    // (Apr 2023), and SSE-S3 (AES256) default encryption (Jan 2023). A CDK bucket that
    // does not declare these reports all three on every first run, yet they are the
    // (secure) AWS default, not an edit. Equality-gated like every KNOWN_DEFAULTS
    // entry: weaken any of them out of band (e.g. BlockPublicAcls=false) and the value
    // no longer matches, so it re-surfaces as real undeclared drift. The encryption
    // shape mirrors what Cloud Control returns today (incl. the newer
    // BlockedEncryptionTypes field); if AWS changes the shape the match simply falls
    // through and the value is shown again — never silently wrong.
    PublicAccessBlockConfiguration: {
      RestrictPublicBuckets: true,
      BlockPublicPolicy: true,
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
    },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          BucketKeyEnabled: false,
          BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] },
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        },
      ],
    },
  },
  // R66 (dogfood-observed service defaults):
  'AWS::Lambda::Function': {
    TracingConfig: { Mode: 'PassThrough' },
    EphemeralStorage: { Size: 512 },
    PackageType: 'Zip',
    RecursiveLoop: 'Terminate',
    RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' },
    Architectures: ['x86_64'],
    // R70 (observed live on the lambda integ fixture): a never-declared
    // default-config function otherwise reports both on every first run.
    MemorySize: 128,
    Timeout: 3,
  },
  'AWS::Lambda::Url': { InvokeMode: 'BUFFERED' },
  // A published version inherits the function's runtime-management config; a version
  // that pins nothing reads back the Auto default (observed live across every
  // `currentVersion` in a multi-function stack). The twin of the AWS::Lambda::Function
  // RuntimeManagementConfig default above; pin a version to a specific runtime and the
  // object no longer matches (equality-gated). The version's CodeSha256 is a per-deploy
  // content hash (not a constant default) — folded as `generated` via
  // GENERATED_TOPLEVEL_PATHS instead.
  'AWS::Lambda::Version': { RuntimePolicy: { UpdateRuntimeOn: 'Auto' } },
  'AWS::Events::Rule': { EventBusName: 'default' },
  'AWS::Athena::WorkGroup': { State: 'ENABLED' },
  // AmazonMQ Broker service defaults (observed live on the amazonmq-version-readgap
  // fixture): a broker created without these knobs reports all three as undeclared
  // first-run noise. AuthenticationStrategy is SIMPLE unless LDAP is configured;
  // EncryptionOptions falls back to the AWS-owned key when no KMS key is declared;
  // DataReplicationMode is NONE unless cross-region data replication (CRDR) is
  // enabled. Equality-gated like every KNOWN_DEFAULTS entry — a broker that sets a
  // KMS key / LDAP / CRDR reads back a non-matching value and stays undeclared.
  'AWS::AmazonMQ::Broker': {
    AuthenticationStrategy: 'SIMPLE',
    EncryptionOptions: { UseAwsOwnedKey: true },
    DataReplicationMode: 'NONE',
  },
  // Chatbot applies the AdministratorAccess guardrail when none is declared
  // (verified live on a default-config SlackChannelConfiguration).
  'AWS::Chatbot::SlackChannelConfiguration': {
    GuardrailPolicies: ['arn:aws:iam::aws:policy/AdministratorAccess'],
  },
  // CloudTrail materializes the default management-events selector when the
  // template declares EventSelectors [] or omits it (observed live on the
  // harvest3 fixture, R74 — CDK's Trail construct synthesizes `EventSelectors:
  // []` by default, so EVERY default CDK trail otherwise reports declared
  // drift). Also consulted by the declared loop's trivially-empty rule.
  'AWS::CloudTrail::Trail': {
    EventSelectors: [
      {
        IncludeManagementEvents: true,
        ReadWriteType: 'All',
        ExcludeManagementEventSources: [],
        DataResources: [],
      },
    ],
  },
  // R104 (dogfood noise audit across the harvest fixtures): top-level service
  // defaults AWS materializes that the CFn schema does NOT annotate as `default`
  // (so the schema-driven R103 fold can't reach them). All OBSERVED on real
  // default-config resources; equality-gated, so a value set away from the default
  // still surfaces. Resource-/account-/region-specific values (names, ARNs, ids,
  // VpcId, KmsKeyId, NetworkBorderGroup, …) are deliberately NOT listed — those are
  // genuine undeclared inventory, not defaults.
  'AWS::SQS::Queue': {
    DelaySeconds: 0,
    VisibilityTimeout: 30,
    MessageRetentionPeriod: 345600,
    ReceiveMessageWaitTimeSeconds: 0,
    SqsManagedSseEnabled: true,
    // AWS now provisions a 1 MiB max message size by default (observed unanimous
    // across 10 corpus queues that declare none); a queue that pins a smaller value
    // still surfaces (equality-gated).
    MaximumMessageSize: 1048576,
    FifoThroughputLimit: 'perQueue', // FIFO queues only
    DeduplicationScope: 'queue', // FIFO queues only
    KmsDataKeyReusePeriodSeconds: 300, // default 5 min; appears only on SSE-KMS queues
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    HealthCheckEnabled: true,
    HealthCheckPort: 'traffic-port',
    HealthCheckProtocol: 'HTTP',
    HealthCheckTimeoutSeconds: 5,
    UnhealthyThresholdCount: 2,
    ProtocolVersion: 'HTTP1',
    IpAddressType: 'ipv4',
    Matcher: { HttpCode: '200' },
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    IpAddressType: 'ipv4',
    EnablePrefixForIpv6SourceNat: 'off',
  },
  'AWS::EC2::NatGateway': {
    ConnectivityType: 'public',
    AvailabilityMode: 'zonal',
  },
  'AWS::CodeDeploy::DeploymentGroup': {
    // The schema carries no explicit `default`, but its description states the value
    // applied when the property is "unspecified" is UPDATE — CodeDeploy always echoes
    // it back on a group that never declared it (live-observed,
    // codedeploy-deploymentgroup-readgap). Equality-gated, so a switch to IGNORE
    // still surfaces.
    OutdatedInstancesStrategy: 'UPDATE',
  },
  'AWS::EFS::FileSystem': {
    ThroughputMode: 'bursting',
    BackupPolicy: { Status: 'DISABLED' },
    FileSystemProtection: { ReplicationOverwriteProtection: 'ENABLED' },
    PerformanceMode: 'generalPurpose', // R-noise-sweep: default; switching to maxIO no longer matches and surfaces
  },
  'AWS::StepFunctions::StateMachine': {
    StateMachineType: 'STANDARD',
    LoggingConfiguration: { IncludeExecutionData: false, Level: 'OFF' },
    EncryptionConfiguration: { Type: 'AWS_OWNED_KEY' },
  },
  'AWS::ApiGateway::RestApi': {
    ApiKeySourceType: 'HEADER',
    SecurityPolicy: 'TLS_1_0',
    EndpointConfiguration: { IpAddressType: 'ipv4', Types: ['EDGE'] },
    DisableExecuteApiEndpoint: false,
  },
  // A custom domain created without an explicit TLS floor reads back TLS_1_2 (the
  // documented default for REGIONAL/EDGE custom domains; observed live). A domain that
  // pins TLS_1_0 reads a non-matching value and stays undeclared (equality-gated).
  'AWS::ApiGateway::DomainName': {
    SecurityPolicy: 'TLS_1_2',
  },
  // A VPC is in nearly every CDK stack. AWS reports these two constant defaults on
  // every first run when the template does not declare them (raw CfnVPC, or an L2 Vpc
  // that sets only DNS hostnames): InstanceTenancy "default" (vs dedicated/host) and
  // EnableDnsSupport on (the VPC default). Observed live on the vpcpeering-rich /
  // egressonly-rich fixtures. Equality-gated: a dedicated-tenancy VPC or DNS-support
  // disabled out of band no longer matches and surfaces as real undeclared drift.
  'AWS::EC2::VPC': {
    InstanceTenancy: 'default',
    EnableDnsSupport: true,
  },
  'AWS::EC2::Subnet': {
    PrivateDnsNameOptionsOnLaunch: {
      EnableResourceNameDnsARecord: false,
      HostnameType: 'ip-name',
      EnableResourceNameDnsAAAARecord: false,
    },
    // IPv6 feature flags AWS reports off by default on every IPv4 subnet.
    AssignIpv6AddressOnCreation: false,
    EnableDns64: false,
    Ipv6Native: false,
  },
  // R-noise-sweep (found by the ec2-instance-rich hunt, PR #310 follow-up): a fresh
  // EC2 Instance reports these three constant service defaults as undeclared on every
  // first run. They are documented account-/instance-independent defaults — Tenancy
  // "default" (vs dedicated/host), SourceDestCheck on (the routing default), and the
  // "stop" shutdown behavior. Resource-specific live values the same read returns
  // (PrivateIpAddress, SecurityGroups, Volumes, NetworkInterfaces, CpuOptions which is
  // instance-type-derived, …) are deliberately NOT listed — they are genuine undeclared
  // inventory. Equality-gated: flip any out of band and it no longer matches, so it
  // re-surfaces as real undeclared drift.
  'AWS::EC2::Instance': {
    Tenancy: 'default',
    SourceDestCheck: true,
    InstanceInitiatedShutdownBehavior: 'stop',
  },
  // R105 (second dogfood-audit wave): more top-level constant service defaults
  // (same exclusions as R104 — no names/ids/ARNs, no region-/account-specific
  // values, no large/evolving config blobs like Athena WorkGroupConfiguration).
  'AWS::ApiGatewayV2::Api': {
    RouteSelectionExpression: '$request.method $request.path',
    IpAddressType: 'ipv4', // R-noise-sweep: default; flipping to dualstack no longer matches and surfaces
    DisableExecuteApiEndpoint: false,
  },
  'AWS::ApiGatewayV2::Integration': {
    ConnectionType: 'INTERNET',
    TimeoutInMillis: 30000,
  },
  'AWS::CodeBuild::Project': {
    TimeoutInMinutes: 60,
    QueuedTimeoutInMinutes: 480,
    Visibility: 'PRIVATE', // the default; folds to atDefault so a never-declared project is not first-run noise — flipping to PUBLIC_READ no longer matches and surfaces
    Cache: { Type: 'NO_CACHE' }, // BatchGetProjects always returns cache; the unconfigured default folds to atDefault so a never-declared cache is not first-run noise — switching to S3/LOCAL no longer matches and surfaces
  },
  'AWS::DynamoDB::Table': {
    BillingMode: 'PROVISIONED',
    DeletionProtectionEnabled: false,
  },
  'AWS::ECR::Repository': {
    EncryptionConfiguration: { EncryptionType: 'AES256' },
    ImageTagMutability: 'MUTABLE', // R-noise-sweep: default; switching to IMMUTABLE no longer matches and surfaces
  },
  'AWS::Kinesis::Stream': {
    MaxRecordSizeInKiB: 1024,
  },
  'AWS::SSM::Parameter': {
    DataType: 'text',
  },
  'AWS::StepFunctions::Activity': {
    EncryptionConfiguration: { Type: 'AWS_OWNED_KEY' },
  },
  'AWS::SNS::Subscription': {
    FilterPolicyScope: 'MessageAttributes',
  },
  // R-noise-sweep (data-driven from scripts/measure-noise.sh over the golden corpus):
  // constant, documented AWS defaults for common types — never names/ids/ARNs, never
  // region-/account-/AZ-/time-specific values, never engine-derived (RDS windows/port/
  // option-group). Equality-gated like every entry: flip the value out of band and it
  // no longer matches, so it re-surfaces as real undeclared drift.
  'AWS::Cognito::UserPool': {
    MfaConfiguration: 'OFF',
    DeletionProtection: 'INACTIVE',
    UserPoolTier: 'ESSENTIALS',
    // A user pool that does not wire up its own SES identity reads back the
    // Cognito-managed sender (observed live). EmailSendingAccount=COGNITO_DEFAULT is
    // the documented default; a pool that switches to DEVELOPER (its own SES) reads a
    // non-matching object and stays undeclared (equality-gated).
    EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
  },
  'AWS::Cognito::UserPoolClient': {
    EnableTokenRevocation: true,
    AuthSessionValidity: 3,
    // Cognito's default refresh-token validity is 30 (days, the default unit) when a
    // client declares none — observed unanimous across the corpus clients.
    RefreshTokenValidity: 30,
    EnablePropagateAdditionalUserContextData: false,
  },
  'AWS::ECS::Service': {
    SchedulingStrategy: 'REPLICA',
    // A service with no load-balancer health-check grace reads back 0 (the default) —
    // observed unanimous across the corpus services.
    HealthCheckGracePeriodSeconds: 0,
    AvailabilityZoneRebalancing: 'ENABLED', // AWS default for new services
    EnableExecuteCommand: false,
  },
  'AWS::AppSync::GraphQLApi': {
    ApiType: 'GRAPHQL',
    Visibility: 'GLOBAL',
    IntrospectionConfig: 'ENABLED',
    // Observed live on a fresh appsync-resolver-rich deploy: an API that declares
    // neither limit reads back the "no limit" sentinel 0 for both, so every default
    // AppSync API otherwise reports them as first-run undeclared inventory.
    QueryDepthLimit: 0,
    ResolverCountLimit: 0,
    XrayEnabled: false,
  },
  // AppSync Resolvers / Functions default MaxBatchSize to 0 (no batch invocation)
  // when the template declares no batching — observed live on a fresh
  // appsync-resolver-rich deploy across UNIT + PIPELINE resolvers and the Function.
  // Equality-gated: a real batch size set out of band still surfaces.
  'AWS::AppSync::Resolver': {
    MaxBatchSize: 0,
  },
  'AWS::AppSync::FunctionConfiguration': {
    MaxBatchSize: 0,
  },
  // Logs SubscriptionFilter defaults Distribution to "ByLogStream" when undeclared
  // (the only other value is "Random") — observed live on a fresh
  // logs-subscriptionfilter-rich deploy.
  'AWS::Logs::SubscriptionFilter': {
    Distribution: 'ByLogStream',
  },
  'AWS::KMS::Key': {
    Enabled: true,
    KeySpec: 'SYMMETRIC_DEFAULT',
    KeyUsage: 'ENCRYPT_DECRYPT',
    Origin: 'AWS_KMS',
  },
  'AWS::IAM::Group': {
    Path: '/',
  },
  'AWS::IAM::InstanceProfile': {
    Path: '/',
  },
  'AWS::Scheduler::Schedule': {
    GroupName: 'default',
    ActionAfterCompletion: 'NONE',
    ScheduleExpressionTimezone: 'UTC',
  },
  // R-noise-sweep (found by the eni-rich / dbproxy-rich / elasticache-cachecluster-rich
  // hunt): constant, documented service defaults a fresh resource reports as undeclared
  // on every first run. Resource-/AZ-/window-specific values the same read returns
  // (ENI PrivateIpAddress(es), CacheCluster Snapshot/MaintenanceWindow,
  // PreferredAvailabilityZones, CacheParameterGroupName which is engine-version-derived)
  // are deliberately NOT listed — they are genuine undeclared inventory. Equality-gated:
  // flip any out of band and it no longer matches, so it re-surfaces as real drift.
  'AWS::EC2::NetworkInterface': {
    InterfaceType: 'interface',
    Ipv4PrefixCount: 0,
    Ipv6PrefixCount: 0,
    SecondaryPrivateIpAddressCount: 0,
  },
  'AWS::ElastiCache::CacheCluster': {
    NetworkType: 'ipv4',
    IpDiscovery: 'ipv4',
    AZMode: 'single-az',
    AutoMinorVersionUpgrade: true,
    SnapshotRetentionLimit: 0,
  },
  // MemoryDB (managed Redis/Valkey) constant service defaults, observed live on the
  // memorydb-rich fixture: the Redis default Port, auto minor-version upgrade on,
  // data tiering off (returned as the string "false"), and the ipv4 network/discovery
  // defaults. Equality-gated. Per-resource/random values the same read returns
  // (ParameterGroupName is engine-version-derived, Snapshot/MaintenanceWindow are
  // AWS-assigned) are deliberately NOT listed — they are genuine undeclared inventory.
  'AWS::MemoryDB::Cluster': {
    Port: 6379,
    AutoMinorVersionUpgrade: true,
    DataTiering: 'false',
    NetworkType: 'ipv4',
    IpDiscovery: 'ipv4',
  },
  'AWS::RDS::DBProxy': {
    TargetConnectionNetworkType: 'IPV4',
    DefaultAuthScheme: 'NONE',
    EndpointNetworkType: 'IPV4',
  },
  // R-noise-sweep (offline audit of the golden corpus via scripts/measure-noise.sh):
  // constant, documented service defaults common stateful/streaming types report as
  // first-run undeclared inventory. Same exclusions as every entry above — NO
  // names/ids/ARNs, no AZ (us-east-1x / use1-azN), no randomized window
  // (Snapshot/Maintenance/Backup), no engine-/version-derived value (EngineVersion,
  // OptionGroupName, *ParameterGroupName, port), no per-resource IP. Equality-gated:
  // flip any out of band and it no longer matches, so it re-surfaces as real drift.
  // The RDS DBInstance values were observed UNANIMOUS across 3 corpus instances
  // spanning different engines (aurora-mysql + mysql8.0), confirming they are
  // constant service defaults, not engine-derived.
  'AWS::RDS::DBInstance': {
    AutoMinorVersionUpgrade: true,
    BackupTarget: 'region',
    DatabaseInsightsMode: 'standard',
    EngineLifecycleSupport: 'open-source-rds-extended-support',
    MonitoringInterval: 0,
    NetworkType: 'IPV4',
    StorageThroughput: 0,
    // Boolean feature flags off by default (observed unanimous across the corpus
    // instances). NOT folded: per-resource/engine values (Port, EngineVersion,
    // LicenseModel, MasterUsername, StorageType, *ParameterGroupName, CACertificateIdentifier).
    CopyTagsToSnapshot: false,
    DedicatedLogVolume: false,
    EnableIAMDatabaseAuthentication: false,
    EnablePerformanceInsights: false,
    ManageMasterUserPassword: false,
    MultiAZ: false,
    StorageEncrypted: false,
  },
  'AWS::RDS::DBCluster': {
    AutoMinorVersionUpgrade: true,
    DatabaseInsightsMode: 'standard',
    EngineLifecycleSupport: 'open-source-rds-extended-support',
    NetworkType: 'IPV4',
    EngineMode: 'provisioned', // default; serverless/parallelquery are explicit opt-ins
  },
  'AWS::Neptune::DBInstance': {
    AutoMinorVersionUpgrade: true,
  },
  'AWS::Neptune::DBCluster': {
    NetworkType: 'IPV4',
    DBPort: 8182, // Neptune's fixed default port
  },
  'AWS::ElastiCache::ReplicationGroup': {
    AutoMinorVersionUpgrade: true,
    ClusterMode: 'disabled',
    IpDiscovery: 'ipv4',
    NetworkType: 'ipv4',
    ReplicasPerNodeGroup: 0,
  },
  'AWS::ElastiCache::ServerlessCache': {
    SnapshotRetentionLimit: 0,
  },
  'AWS::OpenSearchService::Domain': {
    IPAddressType: 'ipv4',
  },
  'AWS::EC2::VPCEndpoint': {
    IpAddressType: 'ipv4',
  },
  'AWS::EC2::TransitGateway': {
    SecurityGroupReferencingSupport: 'disable',
  },
  'AWS::EC2::FlowLog': {
    MaxAggregationInterval: 600,
  },
  'AWS::Pipes::Pipe': {
    DesiredState: 'RUNNING',
  },
  'AWS::Synthetics::Canary': {
    FailureRetentionPeriod: 31,
    SuccessRetentionPeriod: 31,
    ProvisionedResourceCleanup: 'AUTOMATIC',
  },
  'AWS::MSK::Cluster': {
    EnhancedMonitoring: 'DEFAULT',
    StorageMode: 'LOCAL',
  },
  'AWS::Glue::Job': {
    JobMode: 'SCRIPT',
    MaxRetries: 0,
  },
  // R-noise-sweep (PR #355 follow-up): constant service defaults a fresh resource
  // reports as undeclared on every first run. Each is a documented account-/region-
  // independent default (NOT a per-resource id/name/AZ/window/port-that-varies-by-engine),
  // equality-gated like every KNOWN_DEFAULTS entry — flip one out of band and it no
  // longer matches, so it re-surfaces as real drift.
  'AWS::AutoScaling::AutoScalingGroup': {
    Cooldown: '300', // default cooldown 300s (CC returns it as a string)
    HealthCheckType: 'EC2',
    HealthCheckGracePeriod: 0,
  },
  'AWS::DocDB::DBCluster': {
    Port: 27017, // DocDB's fixed default port
  },
  'AWS::SSM::Association': {
    DocumentVersion: '$DEFAULT', // default when no explicit version is pinned
  },
  // CloudWatch alarm defaults. A metric Alarm's `ActionsEnabled` already folds via its
  // CFn schema default, so only `TreatMissingData` (the documented "missing" default,
  // surfaced as undeclared whenever a template omits it — the common case) is added here.
  // DatapointsToAlarm is NOT folded — it defaults to EvaluationPeriods (a per-alarm value,
  // not a constant); EvaluationPeriods/Threshold/ComparisonOperator are required so they
  // are always declared, never first-run noise. CompositeAlarm has NO schema default for
  // `ActionsEnabled` (observed undeclared in the corpus), so it needs the explicit fold.
  'AWS::CloudWatch::Alarm': {
    TreatMissingData: 'missing',
  },
  'AWS::CloudWatch::CompositeAlarm': {
    ActionsEnabled: true,
  },
  'AWS::CloudWatch::MetricStream': {
    IncludeLinkedAccountsMetrics: false,
    State: 'running', // steady state after a successful create
  },
  'AWS::Logs::LogGroup': {
    LogGroupClass: 'STANDARD',
    DeletionProtectionEnabled: false,
    BearerTokenAuthenticationEnabled: false,
  },
  'AWS::ApiGateway::Method': {
    ApiKeyRequired: false,
  },
  'AWS::ApiGatewayV2::Route': {
    ApiKeyRequired: false,
  },
  'AWS::ElasticLoadBalancingV2::ListenerRule': {
    IsDefault: false, // a declared rule is never the listener's default rule
  },
  // A Glue Crawler with no Lake Formation config reads back the "off" sentinel object
  // (empty AccountId + creds disabled) — whole-object equality-gated, so configuring
  // Lake Formation still surfaces.
  'AWS::Glue::Crawler': {
    LakeFormationConfiguration: { AccountId: '', UseLakeFormationCredentials: false },
  },
  // A config-change-triggered ConfigRule reads back EvaluationModes [{Mode:"DETECTIVE"}]
  // (the default) when the template does not declare it. Observed live on the
  // config-rule-rich fixture. Equality-gated: a PROACTIVE mode no longer matches.
  'AWS::Config::ConfigRule': {
    EvaluationModes: [{ Mode: 'DETECTIVE' }],
  },
  // CloudWatch RUM AppMonitor service defaults (observed live on the
  // rum-appmonitor-rich fixture): a monitor that does not declare Platform reads
  // back "Web" (the default/only web platform), and one that does not configure
  // source-map deobfuscation reads back the disabled-state object. Equality-gated:
  // an Android/iOS platform or an enabled deobfuscation config no longer matches and
  // surfaces as a real undeclared value.
  'AWS::RUM::AppMonitor': {
    Platform: 'Web',
    DeobfuscationConfiguration: { JavaScriptSourceMaps: { Status: 'DISABLED' } },
  },
};

// R108: nested service defaults — the NESTED-path twin of KNOWN_DEFAULTS. The
// Cloud Control read returns the full live model, so a config-dense type's
// DECLARED parent property (CloudFront DistributionConfig, ApiGateway Method
// Integration, Glue TableInput, …) comes back carrying many sub-keys AWS
// materialized as documented defaults the user never set. R103's
// `schema.defaultPaths` folds the ones the CFn schema annotates with `default`;
// the schema annotates very few, so the rest flood a first run as `undeclared`
// (nested) noise. This table is the hand-coded equivalent for the nested paths
// the schema does NOT annotate — exactly what KNOWN_DEFAULTS is for top-level
// keys, lifted to dotted paths.
//
// Keyed BY DOTTED PATH with `*` for array elements, matching the shape the
// classify nested loop computes (`path.replace(/\[[^\]]*\]/g, '.*')`) and the
// shape `schema.defaultPaths` already uses, so both sources read through one
// lookup. The VALUE is the exact emitted live value: a leaf scalar when the
// parent array/object is declared and only a sub-leaf is live-only, or the whole
// sub-object when an entire sub-key is live-only. Every entry below was OBSERVED
// verbatim in the golden corpus.
//
// Equality-gated exactly like KNOWN_DEFAULTS: a value folds to `atDefault` ONLY
// when it deep-equals the listed default, so an out-of-band change away from the
// default no longer matches and falls through to a real `undeclared` finding;
// `atDefault` is still surfaced (folded into the report footer, listed by
// --show-all), never dropped and never recorded by record. Values that are a
// generated ID (not a constant) are EXCLUDED here and folded as `generated`
// instead — via GENERATED_DEFAULTS / isGeneratedName, or GENERATED_PATHS for a
// nested id cdkrd cannot template (ApiGateway Method `Integration.CacheNamespace`,
// the parent Resource's id). Genuine resource-/account-/throughput inventory stays
// EXCLUDED from both (Budgets `Budget.BudgetName`, DynamoDB GSI `*.WarmThroughput`).
export const KNOWN_DEFAULT_PATHS: Record<string, Record<string, unknown>> = {
  'AWS::ApiGateway::DomainName': {
    // AWS sets a custom domain's IP address type to ipv4 when the template leaves
    // EndpointConfiguration.IpAddressType unset — a server default, not user intent.
    'EndpointConfiguration.IpAddressType': 'ipv4',
  },
  'AWS::ApiGateway::Method': {
    'Integration.PassthroughBehavior': 'WHEN_NO_MATCH',
    'Integration.ResponseTransferMode': 'BUFFERED',
    'Integration.TimeoutInMillis': 29000,
  },
  'AWS::ApiGateway::UsagePlan': {
    'Quota.Offset': 0,
  },
  'AWS::CloudFront::Distribution': {
    'DistributionConfig.OriginGroups': { Quantity: 0, Items: [] },
    'DistributionConfig.Origins.*.ConnectionAttempts': 3,
    'DistributionConfig.Origins.*.ConnectionTimeout': 10,
    'DistributionConfig.Origins.*.CustomOriginConfig.HTTPPort': 80,
    'DistributionConfig.Origins.*.CustomOriginConfig.HTTPSPort': 443,
    'DistributionConfig.Origins.*.CustomOriginConfig.OriginKeepaliveTimeout': 5,
    'DistributionConfig.Origins.*.S3OriginConfig.OriginReadTimeout': 30,
    'DistributionConfig.Restrictions': {
      GeoRestriction: { Locations: [], RestrictionType: 'none' },
    },
    'DistributionConfig.ViewerCertificate': {
      SslSupportMethod: 'vip',
      MinimumProtocolVersion: 'TLSv1',
      CloudFrontDefaultCertificate: true,
    },
  },
  'AWS::CodeBuild::Project': {
    'Environment.ImagePullCredentialsType': 'CODEBUILD',
    // A project with no explicit artifacts (NO_ARTIFACTS source) reads back the
    // Packaging default NONE — R-noise-sweep, observed live.
    'Artifacts.Packaging': 'NONE',
  },
  'AWS::Cognito::UserPool': {
    'AdminCreateUserConfig.UnusedAccountValidityDays': 7,
    'Policies.SignInPolicy': { AllowedFirstAuthFactors: ['PASSWORD'] },
    // A pool that declares a PasswordPolicy but omits the temporary-password lifetime
    // reads back the 7-day default (observed live); a pool that sets a different value
    // no longer matches and surfaces (equality-gated).
    'Policies.PasswordPolicy.TemporaryPasswordValidityDays': 7,
  },
  'AWS::DynamoDB::Table': {
    'PointInTimeRecoverySpecification.RecoveryPeriodInDays': 35,
  },
  'AWS::ECS::TaskDefinition': {
    // A container that does not reserve CPU reads back Cpu: 0 (the documented "no
    // reservation" default) for EVERY container, so a multi-container task def floods
    // the first run with `ContainerDefinitions[*].Cpu = 0` not-recorded noise. Fold the
    // constant default to atDefault; a container that actually reserves CPU (Cpu != 0)
    // no longer matches and surfaces. Observed live on the ecs-taskdef-caps deploy.
    'ContainerDefinitions.*.Cpu': 0,
  },
  'AWS::Glue::Database': {
    'DatabaseInput.CreateTableDefaultPermissions': [
      {
        Permissions: ['ALL'],
        Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
      },
    ],
  },
  'AWS::Glue::Table': {
    'TableInput.Retention': 0,
    'TableInput.StorageDescriptor.NumberOfBuckets': 0,
  },
  'AWS::Route53::HealthCheck': {
    'HealthCheckConfig.EnableSNI': true,
  },
  'AWS::Route53::RecordSet': {
    // A geoproximity record may declare only AWSRegion (or Coordinates); AWS then sets
    // Bias to 0 and returns it. Fold that server default so a record that never set a
    // bias stays CLEAN, while a real out-of-band bias change still surfaces.
    'GeoProximityLocation.Bias': 0,
  },
  'AWS::S3::Bucket': {
    'LifecycleConfiguration.TransitionDefaultMinimumObjectSize': 'all_storage_classes_128K',
  },
  'AWS::Scheduler::Schedule': {
    'Target.RetryPolicy': { MaximumEventAgeInSeconds: 86400, MaximumRetryAttempts: 185 },
  },
  'AWS::ECS::Service': {
    // A service declaring no deployment configuration reads back AWS's defaults — the
    // ROLLING strategy with a 0-minute bake time. Observed unanimous across the corpus.
    'DeploymentConfiguration.Strategy': 'ROLLING',
    'DeploymentConfiguration.BakeTimeInMinutes': 0,
  },
  'AWS::OpenSearchService::Domain': {
    // A gp3 EBS volume reads back the gp3 baseline 3000 IOPS / 125 MiB/s throughput
    // when the template leaves them unset — server defaults, not user intent.
    'EBSOptions.Iops': 3000,
    'EBSOptions.Throughput': 125,
  },
  'AWS::KinesisFirehose::DeliveryStream': {
    // S3 backup is Disabled by default when a destination declares no backup mode.
    'ExtendedS3DestinationConfiguration.S3BackupMode': 'Disabled',
  },
  // R-noise-sweep (offline corpus audit): nested constant defaults the schema does
  // not annotate. Equality-gated; a non-default value still surfaces.
  'AWS::WAFv2::WebACL': {
    // A rate-based rule with no explicit window reads back the 5-minute (300s) default.
    'Rules.*.Statement.RateBasedStatement.EvaluationWindowSec': 300,
  },
  'AWS::SES::EmailIdentity': {
    // A custom MAIL FROM domain reads back the documented default fallback behavior.
    'MailFromAttributes.BehaviorOnMxFailure': 'USE_DEFAULT_VALUE',
  },
  'AWS::MSK::Cluster': {
    // Brokers spread across AZs read back the DEFAULT distribution when unspecified.
    'BrokerNodeGroupInfo.BrokerAZDistribution': 'DEFAULT',
  },
  'AWS::Batch::JobDefinition': {
    // A Fargate job definition reads back the documented runtime-platform defaults
    // (x86_64 / Linux) and the LATEST Fargate platform version when none is declared.
    'ContainerProperties.RuntimePlatform.CpuArchitecture': 'X86_64',
    'ContainerProperties.RuntimePlatform.OperatingSystemFamily': 'LINUX',
    'ContainerProperties.FargatePlatformConfiguration.PlatformVersion': 'LATEST',
  },
};

// Default ELEMENTS of an identity-keyed SUBSET array (the per-element twin of
// KNOWN_DEFAULT_PATHS): keyed by resourceType → array property → element identity →
// the exact default element shape. When a live-only element of an
// IDENTITY_KEYED_SUBSET_ARRAYS property (classify) deep-equals its entry here, it folds
// to `atDefault` instead of nested `undeclared` — the same equality-gated treatment a
// top-level default value gets, lifted to a keyed array element.
//
// The motivating case: a Cognito user pool ALWAYS returns the full set of ~20 OIDC
// standard attributes in `Schema`, whether or not the template declares them, so a pool
// that declares only custom (or a few standard) attributes floods every first run with
// ~20 live-only standard-attribute entries. They are a FIXED, platform-provided default
// set and are IMMUTABLE after pool creation (a standard attribute's Mutable / Required /
// constraints cannot be changed later), so they can never be an out-of-band edit. A
// standard attribute the template DECLARES (customizing it) is matched by identity and
// compared instead (never reaching the live-only fold); any future shape AWS returns that
// differs simply falls through to undeclared. Shapes captured live (ap-northeast-1).
const cognitoStdAttr = (
  Name: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  AttributeDataType: 'String',
  DeveloperOnlyAttribute: false,
  Mutable: true,
  Name,
  Required: false,
  StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
  ...over,
});
const COGNITO_STRING_STD = [
  'address',
  'email',
  'family_name',
  'gender',
  'given_name',
  'locale',
  'middle_name',
  'name',
  'nickname',
  'phone_number',
  'picture',
  'preferred_username',
  'profile',
  'website',
  'zoneinfo',
];
export const IDENTITY_KEYED_DEFAULT_ELEMENTS: Record<
  string,
  Record<string, Record<string, Record<string, unknown>>>
> = {
  'AWS::Cognito::UserPool': {
    Schema: {
      ...Object.fromEntries(COGNITO_STRING_STD.map((n) => [n, cognitoStdAttr(n)])),
      birthdate: cognitoStdAttr('birthdate', {
        StringAttributeConstraints: { MinLength: '10', MaxLength: '10' },
      }),
      // `sub` is the immutable, required subject identifier
      sub: cognitoStdAttr('sub', {
        Mutable: false,
        Required: true,
        StringAttributeConstraints: { MinLength: '1', MaxLength: '2048' },
      }),
      // `identities` (federated-identity links) carries empty string constraints
      identities: cognitoStdAttr('identities', { StringAttributeConstraints: {} }),
      // `updated_at` is a Number with a min-value constraint and no string constraints
      updated_at: {
        AttributeDataType: 'Number',
        DeveloperOnlyAttribute: false,
        Mutable: true,
        Name: 'updated_at',
        NumberAttributeConstraints: { MinValue: '0' },
        Required: false,
      },
      // the two *_verified flags are Booleans with no constraints
      email_verified: {
        AttributeDataType: 'Boolean',
        DeveloperOnlyAttribute: false,
        Mutable: true,
        Name: 'email_verified',
        Required: false,
      },
      phone_number_verified: {
        AttributeDataType: 'Boolean',
        DeveloperOnlyAttribute: false,
        Mutable: true,
        Name: 'phone_number_verified',
        Required: false,
      },
    },
  },
};

// AWS/CDK auto-GENERATED values keyed by the resource's CFn-assigned physical id.
// Unlike KNOWN_DEFAULTS (static values), each entry may interpolate the live
// physical id via two placeholders, substituted by resolveGeneratedDefault before
// the equality gate:
//   ${PHYSICAL_ID}   - the PhysicalResourceId verbatim (an ARN or a bare name,
//                      depending on the resource type)
//   ${PHYSICAL_NAME} - its trailing name segment (after the last ':' or '/'); for
//                      an ARN physical id this is the bare resource name
// These are the identifiers AWS minted for the resource, not user intent: a topic's
// generated TopicName, a function's default LoggingConfig whose LogGroup is named
// after the generated function name. They flood a first run as "undeclared" yet the
// user never set and cannot meaningfully edit them. Classified as the `generated`
// tier (folded inventory like atDefault), equality-gated exactly like KNOWN_DEFAULTS:
// an out-of-band edit (a JSON LogFormat, say) no longer matches the substituted
// template and falls through to a real `undeclared` finding. Never recorded by record.
// GENERATED_DEFAULTS only carries the STRUCTURED cases the general name rule below
// (isGeneratedName) cannot express — e.g. a Lambda's default LoggingConfig OBJECT,
// where the generated name is one sub-field of an object also containing a literal
// default (LogFormat: 'Text'). A bare generated NAME echoed as a scalar property
// (a topic's TopicName, a state machine's StateMachineName, a bucket's BucketName)
// needs no entry — isGeneratedName folds it for ANY resource type.
export const GENERATED_DEFAULTS: Record<string, Record<string, unknown>> = {
  'AWS::Lambda::Function': {
    LoggingConfig: { LogFormat: 'Text', LogGroup: '/aws/lambda/${PHYSICAL_NAME}' },
  },
};

// NESTED paths whose value is an AWS-assigned generated id that ECHOES a segment of
// the resource's physical id — for ids cdkrd cannot template from a single placeholder.
// Example: an ApiGateway Method's `Integration.CacheNamespace` defaults to the PARENT
// Resource's id, which is the MIDDLE segment of the Method's own physical id
// (`RestApiId|ResourceId|HttpMethod`); neither KNOWN_DEFAULT_PATHS (a fixed value) nor
// GENERATED_DEFAULTS (a single-placeholder template on the resource's own id) can express
// it. Folded into the `generated` tier (inventory, never drift, never recorded) ONLY when
// the value matches a physical-id segment (isPhysicalIdSegment) — so the AWS default stays
// quiet while a CUSTOM value the user actually set still surfaces as undeclared, and an
// out-of-band change to it reports as drift (R142; was value-independent in R140).
export const GENERATED_PATHS: Record<string, string[]> = {
  'AWS::ApiGateway::Method': ['Integration.CacheNamespace'],
};

// Top-level UNDECLARED keys that are ALWAYS a service-minted, AWS-managed generated
// id — value-INDEPENDENT (unlike GENERATED_PATHS/isPhysicalIdSegment, the value is an
// opaque churning id, not derivable from the physical id). An ApiGatewayV2 Stage with
// AutoDeploy=true (the CDK HttpApi default) has its `DeploymentId` minted and re-minted
// by the service on every auto-deployment; the user cannot set it (a manual set is
// rejected: "Deployment ID cannot be set ... because AutoDeploy is enabled"). It is
// live-only ONLY in the AutoDeploy case — a non-AutoDeploy stage DECLARES DeploymentId,
// so it never reaches the undeclared loop — so folding it as `generated` (inventory:
// never drift, never recorded, never reverted) is safe AND necessary: otherwise the id
// churns into a false undeclared drift after ANY out-of-band API edit, and a revert of
// it fails (AutoDeploy rejects the write) so the stack never converges. Observed live on
// a fresh apigwv2-http-rich deploy.
export const GENERATED_TOPLEVEL_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::ApiGatewayV2::Stage': new Set(['DeploymentId']),
  // A published version's CodeSha256 is the base64 hash of the deployed code package —
  // a per-deploy, opaque, service-minted value (NOT a constant default, so KNOWN_DEFAULTS
  // cannot fold it). It is live-only ONLY when the template does not pin it; a version
  // that DECLARES CodeSha256 (to gate publication on specific code) carries it in the
  // template and never reaches the undeclared loop. Folding the live-only case as
  // `generated` (inventory: never drift, never recorded, never reverted) stops every
  // `currentVersion` in a stack flooding the first run — observed across a 7-function
  // stack. The version resource is immutable, so the hash can never be an out-of-band edit.
  'AWS::Lambda::Version': new Set(['CodeSha256']),
};

// R142: true when `value` equals a `|`/`:`/`/`-separated SEGMENT of the physical id.
// Folds a GENERATED_PATHS value only when it ECHOES an id AWS minted (an ApiGateway
// Method's CacheNamespace = the parent Resource id, the middle segment of
// `RestApiId|ResourceId|HttpMethod`), leaving a user-set custom value to surface.
export function isPhysicalIdSegment(value: unknown, physicalId: string | undefined): boolean {
  if (typeof value !== 'string' || physicalId === undefined) return false;
  return physicalId.split(/[|:/]/).includes(value);
}

// R107: a scalar property whose value IS this resource's generated NAME taken from
// an ARN physical id — the ARN's trailing name segment (a topic's TopicName, a
// state machine's StateMachineName). This is the identity AWS minted, never user
// intent, and appears on every first run for any ARN-keyed auto-named type.
// Generalizes the per-type GENERATED_DEFAULTS so such a type needs no table entry.
// Deliberately EXCLUDES `value === physicalId` (the bare-id echo — e.g. a RoleName /
// AlarmName whose physical id IS the name, or a property echoing the whole ARN):
// that remains the long-standing structural-noise drop in classify, unchanged, so
// this stays a narrow, additive rule (only the ARN name-segment case). Strict
// equality + the hash suffix in a generated name make a coincidental user-value
// match effectively impossible; a renamed/edited value simply won't match.
export function isGeneratedName(value: unknown, physicalId: string | undefined): boolean {
  if (typeof value !== 'string' || physicalId === undefined || value === physicalId) return false;
  return value === physicalNameOf(physicalId);
}

function physicalNameOf(physicalId: string): string {
  const segs = physicalId.split(/[:/]/);
  return segs[segs.length - 1] || physicalId;
}

function substitutePhysical(value: unknown, id: string, name: string): unknown {
  if (typeof value === 'string')
    return value.split('${PHYSICAL_ID}').join(id).split('${PHYSICAL_NAME}').join(name);
  if (Array.isArray(value)) return value.map((v) => substitutePhysical(v, id, name));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substitutePhysical(v, id, name),
      ])
    );
  return value;
}

// Resolve the GENERATED_DEFAULTS template for a resource type against its live
// physical id, returning the per-property expected values (placeholders filled) or
// undefined when the type has no template / the physical id is unknown. The classify
// undeclared loop then equality-gates a live value against `result[key]`.
export function resolveGeneratedDefault(
  resourceType: string,
  physicalId: string | undefined
): Record<string, unknown> | undefined {
  const tmpl = GENERATED_DEFAULTS[resourceType];
  if (!tmpl || physicalId === undefined) return undefined;
  return substitutePhysical(tmpl, physicalId, physicalNameOf(physicalId)) as Record<
    string,
    unknown
  >;
}

// Strip AWS-managed (aws:*) tag ELEMENTS from the live side so a declared tag
// set (which never contains aws:* tags) compares equal to the live set (which
// AWS augments with aws:cloudformation:* etc.). Handles {Key,Value}[] lists at
// any depth (shape-specific enough to be safe) and key->value maps ONLY under a
// key named `Tags` (R69): the old strip-any-`aws:`-map-key-anywhere rule also
// deleted IAM condition keys (`Condition.Bool["aws:SecureTransport"]`,
// aws:SourceArn, aws:PrincipalOrgID, ...) from live policy documents, turning
// every CDK enforceSSL-style statement into a desired-vs-undefined false drift
// (found by the first live policies integ run).
export function stripAwsTagsDeep(v: unknown): unknown {
  return stripTagsWalk(v, false);
}

function stripTagsWalk(v: unknown, underTagsKey: boolean): unknown {
  if (Array.isArray(v)) {
    return v
      .filter(
        (t) =>
          !(
            t &&
            typeof t === 'object' &&
            typeof (t as { Key?: unknown }).Key === 'string' &&
            (t as { Key: string }).Key.startsWith('aws:')
          )
      )
      .map((t) => stripTagsWalk(t, false));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (underTagsKey && k.startsWith('aws:')) continue;
      out[k] = stripTagsWalk(val, k === 'Tags');
    }
    return out;
  }
  return v;
}

// CFn arrays of IDENTITY-KEYED objects are UNORDERED sets: CDK declares them in one
// order, AWS returns them in another, so a positional diff reports false drift on
// every element. Two cases share this shape:
//   - tag lists ({Key,Value}[]) — keyed by `Key` (subnets are the worst offender);
//   - CloudFront DistributionConfig.Origins ({Id,DomainName,...}[]) — keyed by `Id`
//     (a multi-origin distribution returns the origins in a different order, which
//     otherwise reports a false drift on EVERY field of every swapped origin).
// Canonicalize any array whose every element is an object carrying a string identity
// field (`Key` preferred, else `Id`) by sorting on that field (JSON tiebreak for
// stability). Applied to BOTH sides before the diff, so a reordered-but-equal set
// compares equal; a genuine change to one element still differs after the sort.
// Recurses so nested bags (LaunchTemplate TagSpecifications, Origins, ...) are covered.
// ASSUMPTION: no `Key`- or `Id`-keyed AWS array is known to be order-significant, so
// sorting is safe (same conservative bet as the scalar id-array canonicalizer).
// R88: `AttributeName` and `IndexName` extend this to DynamoDB's identity-keyed
// arrays — AttributeDefinitions / KeySchema (keyed by AttributeName) and
// GlobalSecondaryIndexes (keyed by IndexName), which AWS returns in a different order
// than the template declares them (a positional diff otherwise reports false drift on
// every element). Both are set-like identities, not order-significant.
// WAVE24: `Name` extends it to the very common `[{Name,Value}]` shape — ECS
// TaskDefinition ContainerDefinitions[].Environment / Secrets / Ulimits and CloudWatch
// Alarm Dimensions — which Cloud Control returns in a DIFFERENT order than declared
// (PROVEN live: a 5-var Environment came back fully shuffled), false-flagging every
// shifted element as `declared` drift. Sorting is comparison-only (both sides, never
// written back) and `identityField` requires EVERY element to carry a string `Name`, so
// order-significant arrays without a Name on every element (CloudFront CacheBehaviors —
// precedence-ordered, no Name; un-named ECS PortMappings) stay UNSORTED. The baseline's
// `DELTA_IDENTITY_FIELDS` already includes `Name`; this aligns the compare side to it.
const IDENTITY_FIELDS = ['Key', 'Id', 'AttributeName', 'IndexName', 'Name'] as const;
// Exported for classify's nested-undeclared array descent (R98): an identity-keyed
// object array (Tags/Origins/AttributeDefinitions/…) can be aligned element-by-element
// by its identity value, so a live-only SUB-key inside a declared element is detected.
export function identityField(arr: unknown[]): string | undefined {
  return IDENTITY_FIELDS.find((f) =>
    arr.every(
      (t) => t && typeof t === 'object' && typeof (t as Record<string, unknown>)[f] === 'string'
    )
  );
}

// AWS sometimes GENERATES an identity field the template omitted — most commonly
// `S3 LifecycleConfiguration.Rules[].Id`: `bucket.addLifecycleRule({...})` without an
// `id` is the CDK default, so the template carries no `Id`, but S3 assigns a random one
// and echoes it on read. The live element then has the identity field while the declared
// element does not, so the per-side identity sort (`canonicalizeTagLists` / `identityField`)
// sorts the LIVE array by the generated id but leaves the DECLARED array in template order
// — misaligning every element into a wall of false `declared` drift (observed live: three
// no-id lifecycle rules reported 8 phantom drifts). AWS preserves the array's declared
// order (Cloud Control read), so the safe fix is to NOT let an asymmetric identity field
// drive the sort: walk the declared/live pair in parallel and, at any object array where
// an IDENTITY_FIELD is present on EVERY element of one side but NOT every element of the
// other, delete that field from BOTH sides. Neither side is then keyed by it, both stay in
// positional order, and the compare aligns. A field present on BOTH sides (CloudFront
// Origins Id, Tags Key, …) is untouched, so the existing identity-keyed canonicalization is
// unaffected. Mutates the passed (cloned) structures in place; run BEFORE canonicalization.
export function stripAsymmetricIdentityFields(declared: unknown, live: unknown): void {
  const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);
  if (Array.isArray(declared) && Array.isArray(live)) {
    if (declared.length > 0 && live.length > 0 && declared.every(isObj) && live.every(isObj)) {
      for (const f of IDENTITY_FIELDS) {
        const decAll = declared.every((e) => typeof (e as Record<string, unknown>)[f] === 'string');
        const liveAll = live.every((e) => typeof (e as Record<string, unknown>)[f] === 'string');
        if (decAll !== liveAll) {
          for (const e of declared) delete (e as Record<string, unknown>)[f];
          for (const e of live) delete (e as Record<string, unknown>)[f];
        }
      }
    }
    const n = Math.min(declared.length, live.length);
    for (let i = 0; i < n; i++) stripAsymmetricIdentityFields(declared[i], live[i]);
    return;
  }
  if (isObj(declared) && isObj(live)) {
    for (const k of Object.keys(declared))
      if (k in live) stripAsymmetricIdentityFields(declared[k], live[k]);
  }
}
// Identity-keyed OBJECT arrays that carry a per-element `Name` (so `identityField`
// would otherwise sort them) but whose ARRAY ORDER is SEMANTICALLY SIGNIFICANT.
// Sorting such an array is doubly wrong: (a) it MASKS a genuine reorder as no-drift
// (FP/FN), and (b) the drift finding's array index then points into the SORTED model
// while the revert (Cloud Control `UpdateResource`) patch addresses the RAW UNSORTED
// live model — so the patch lands on the WRONG element and the revert silently no-ops
// (the same index-misalignment class as the policy-statement bug, but CC-side).
// Keyed by resourceType -> the set of property KEY NAMES (at ANY depth) whose array
// value must stay in declared order. CodePipeline Stages execute top-to-bottom, and
// each stage's Actions are returned by Cloud Control in declared order; both compare
// positionally. The exclusion is type-scoped (only applied when canonicalizeForCompare
// is given this resourceType), so a same-named array on an unrelated type is unaffected.
export const ORDER_SIGNIFICANT_ARRAY_KEYS: Record<string, ReadonlySet<string>> = {
  'AWS::CodePipeline::Pipeline': new Set(['Stages', 'Actions']),
};
export function canonicalizeTagListsDeep(v: unknown, orderSig?: ReadonlySet<string>): unknown {
  return canonicalizeTagLists(v, orderSig, undefined);
}
// `keyHere` is the property name the value `v` sits under (undefined at the root and
// for array ELEMENTS), so an array directly under an order-significant key is left in
// place while its elements still recurse for nested tag/id-list canonicalization.
function canonicalizeTagLists(
  v: unknown,
  orderSig: ReadonlySet<string> | undefined,
  keyHere: string | undefined
): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map((el) => canonicalizeTagLists(el, orderSig, undefined));
    if (keyHere !== undefined && orderSig?.has(keyHere)) return mapped;
    const idf = mapped.length > 0 ? identityField(mapped) : undefined;
    if (idf) {
      return [...mapped].sort((a, b) => {
        const ka = String((a as Record<string, unknown>)[idf]); // identityField verified string
        const kb = String((b as Record<string, unknown>)[idf]);
        if (ka !== kb) return ka < kb ? -1 : 1;
        return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
      });
    }
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = canonicalizeTagLists(val, orderSig, k);
    return out;
  }
  return v;
}

// Per-attribute-key AWS defaults for the ELB attribute bags (LoadBalancerAttributes /
// TargetGroupAttributes). ELB always echoes ~15-20 attribute keys the template never
// declares (the server defaults); classify emits each live-only key as nested
// `undeclared` inventory (R95, fail-closed). For a key whose live value EQUALS its
// documented constant default, that is first-run NOISE — surface it in the `atDefault`
// tier instead (informational, never drift, mirrors KNOWN_DEFAULT_PATHS for nested
// scalar defaults). This is a CURATED, equality-gated, per-KEY table — NOT the wildcard
// the R95 comment warned against: a key absent here, or present with a non-default value,
// still classifies `undeclared` (recorded by `record`, a later change surfaces as drift).
// Values are strings (the bag stores everything stringly); the empty-string keys
// (access_logs.s3.bucket/prefix, …) are already dropped by isTrivialEmpty. Every value
// below is OBSERVED constant across every ELB corpus case. Keys whose default is value-
// identical but type-specific (e.g. an NLB's differing default) stay safe via the
// equality gate — a non-matching live value simply does not fold.
export const ELB_ATTRIBUTE_DEFAULTS: Record<string, Record<string, string>> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    'access_logs.s3.enabled': 'false',
    'client_keep_alive.seconds': '3600',
    'connection_logs.s3.enabled': 'false',
    'health_check_logs.s3.enabled': 'false',
    // ALB idle_timeout default (observed live on a bare ALB that declared no
    // idleTimeout). NLB has no idle_timeout attribute, so no cross-type conflict.
    'idle_timeout.timeout_seconds': '60',
    // ALB cross-zone load balancing is always on and not configurable -> AWS always
    // returns "true". NB: an NLB's cross_zone default is "false" — the OPPOSITE — and
    // this table is keyed only by resourceType (shared ALB/NLB), so the two cannot both
    // fold; the ALB value wins and an NLB's cross_zone stays `undeclared` (a known minor
    // residual; the equality gate keeps it correct, never mis-folding).
    'load_balancing.cross_zone.enabled': 'true',
    // NLB-only attribute keys (an ALB never returns them, so no conflict) — observed live
    // on a bare internal NLB.
    'dns_record.client_routing_policy': 'any_availability_zone',
    'secondary_ips.auto_assigned.per_subnet': '0',
    'routing.http.desync_mitigation_mode': 'defensive',
    'routing.http.drop_invalid_header_fields.enabled': 'false',
    'routing.http.preserve_host_header.enabled': 'false',
    'routing.http.x_amzn_tls_version_and_cipher_suite.enabled': 'false',
    'routing.http.xff_client_port.enabled': 'false',
    'routing.http.xff_header_processing.mode': 'append',
    'routing.http2.enabled': 'true',
    'waf.fail_open.enabled': 'false',
    'zonal_shift.config.enabled': 'false',
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    'load_balancing.algorithm.anomaly_mitigation': 'off',
    'load_balancing.algorithm.type': 'round_robin',
    'load_balancing.cross_zone.enabled': 'use_load_balancer_configuration',
    'slow_start.duration_seconds': '0',
    // latent stickiness defaults AWS returns even while stickiness.enabled is false
    'stickiness.app_cookie.duration_seconds': '86400',
    'stickiness.lb_cookie.duration_seconds': '86400',
    'stickiness.type': 'lb_cookie',
    'target_group_health.dns_failover.minimum_healthy_targets.count': '1',
    'target_group_health.dns_failover.minimum_healthy_targets.percentage': 'off',
    'target_group_health.unhealthy_state_routing.minimum_healthy_targets.count': '1',
    'target_group_health.unhealthy_state_routing.minimum_healthy_targets.percentage': 'off',
  },
};

// (R95) The generic `projectLiveToDeclaredSubset` was REMOVED. It projected the live
// side of an identity-keyed array down to only the keys the template declared, to
// mute the extra default attributes ELB returns (declares 2, AWS returns ~15). But
// projecting away every undeclared live element ALSO silently dropped genuine
// out-of-band ADDITIONS to any identity-keyed array — a console-added Tag, an extra
// CloudFront Origin — a false negative a drift tool must never produce (fail-closed:
// report, do not suppress). The one type that needed subset behaviour, ELB attribute
// bags, is handled in classify by ELB_ATTRIBUTE_BAGS (R78, compare BY KEY); the
// golden corpus confirmed no other type relied on the projection.

// A declared OBJECT/ARRAY whose live counterpart is the same value serialized as a
// JSON STRING (R75: SSM Document.Content — CDK declares the parsed object, AWS
// returns a JSON string, with keys in a different order). The compare is
// key-order-insensitive, so a successful parse + structural equality means
// equal-not-drift. One side must be a string and the other a non-null object; a
// genuine content change still differs after the parse.
const SENTINEL_UNPARSEABLE = Symbol('unparseable');
function deepCompareUnordered(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const ba = b as unknown[];
    return (
      (a as unknown[]).length === ba.length &&
      (a as unknown[]).every((v, i) => deepCompareUnordered(v, ba[i]))
    );
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return (
    ak.length === Object.keys(bo).length &&
    ak.every((k) => Object.hasOwn(bo, k) && deepCompareUnordered(ao[k], bo[k]))
  );
}
export function isJsonStringStructEqual(a: unknown, b: unknown): boolean {
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return SENTINEL_UNPARSEABLE;
    }
  };
  if (typeof a === 'string' && b !== null && typeof b === 'object') {
    const pa = parse(a);
    return pa !== SENTINEL_UNPARSEABLE && deepCompareUnordered(pa, b);
  }
  if (typeof b === 'string' && a !== null && typeof a === 'object') {
    const pb = parse(b);
    return pb !== SENTINEL_UNPARSEABLE && deepCompareUnordered(a, pb);
  }
  return false;
}

// Per-type property paths AWS compares CASE-INSENSITIVELY (R75: Route53
// RecordSet AliasTarget.DNSName — an ALB's generated DNS name is mixed-case in
// the template's GetAtt and all-lowercase in the live record; DNS hostnames are
// case-insensitive). Observed-only entries. The drift path is the dotted path
// from calculateResourceDrift (e.g. `AliasTarget.DNSName`).
export const CASE_INSENSITIVE_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::Route53::RecordSet': new Set(['AliasTarget.DNSName']),
  // Batch ComputeEnvironment `Type` — CDK's `FargateComputeEnvironment` /
  // `ManagedComputeEnvironment` emits the value LOWERCASE (`managed`) in the
  // template, but the Batch API accepts it case-insensitively and the live read
  // canonicalizes it UPPERCASE (`MANAGED`), so a case-sensitive compare false-flags
  // declared drift on every check of a freshly deployed managed compute environment.
  // `Type` is create-only (managed<->unmanaged can't be toggled out of band) and the
  // two valid values differ beyond case, so case-insensitive equality hides no real
  // drift. Observed live on a fresh batch-rich deploy.
  'AWS::Batch::ComputeEnvironment': new Set(['Type']),
};
export function isCaseInsensitiveScalarEqual(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// Per-type property paths whose value is a set of HTTP HEADER NAMES, which AWS
// stores/echoes LOWERCASED (header names are case-insensitive per RFC 9110). The
// template keeps the author's casing (CDK CORS `AllowHeaders:
// ["Content-Type","Authorization"]`), but the live read returns them lowercased
// (`["content-type","authorization"]`), so a positional/case-sensitive diff
// reports false declared drift on every check. Compared case- AND order-
// insensitively (a CORS header list is an unordered set); a genuine header
// add/remove still differs. Observed live on a fresh apigwv2-http-rich deploy.
export const CASE_INSENSITIVE_ARRAY_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::ApiGatewayV2::Api': new Set([
    'CorsConfiguration.AllowHeaders',
    'CorsConfiguration.ExposeHeaders',
  ]),
};
// True when both values are string arrays holding the same multiset of values
// modulo ASCII case (order- and case-insensitive). Non-string-array inputs never
// match — header sets only.
export function isCaseInsensitiveEqualScalarSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  if (!a.every((v) => typeof v === 'string') || !b.every((v) => typeof v === 'string'))
    return false;
  const norm = (arr: unknown[]): string[] => (arr as string[]).map((s) => s.toLowerCase()).sort();
  const na = norm(a);
  const nb = norm(b);
  return na.every((v, i) => v === nb[i]);
}

// Per-type property paths whose value is a `rate(N unit)` schedule expression that the
// SERVICE canonicalizes to whole units. CloudWatch Synthetics rewrites a canary's
// `rate(60 minutes)` to `rate(1 hour)` (CDK's Canary emits the minutes form from
// `Duration.hours(1)`), so a string compare false-flags declared drift on every check.
// Compared by NUMERIC DURATION, so an equivalent expression is not drift but a genuine
// interval change still differs. Observed SYNTHETICS-SPECIFIC: EventBridge Scheduler
// (and Events::Rule) echo the rate expression VERBATIM (proven live — a scheduler
// fixture declaring `rate(1 hour)` read back identically), so they are deliberately NOT
// listed; only paths where the service is observed to rewrite belong here.
export const RATE_EXPRESSION_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::Synthetics::Canary': new Set(['Schedule.Expression']),
};
const RATE_RE = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i;
const RATE_UNIT_MIN: Record<string, number> = { minute: 1, hour: 60, day: 1440 };
// True when both values are `rate(N unit)` expressions of the SAME total duration
// (e.g. `rate(60 minutes)` == `rate(1 hour)`). Only the rate() form is parsed — a
// cron() expression or any unparseable string returns false (strict compare), so a
// genuine schedule change still surfaces.
export function isEquivalentRateExpression(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const minutes = (s: string): number | undefined => {
    const m = RATE_RE.exec(s.trim());
    if (!m || m[1] === undefined || m[2] === undefined) return undefined;
    const unit = m[2].toLowerCase().replace(/s$/, '');
    const per = RATE_UNIT_MIN[unit];
    return per === undefined ? undefined : Number(m[1]) * per;
  };
  const ma = minutes(a);
  const mb = minutes(b);
  return ma !== undefined && mb !== undefined && ma === mb;
}

// Per-type property paths holding a Unix-epoch (seconds) timestamp that AWS rounds
// DOWN to the hour on store: AppSync ApiKey `Expires` (documented "rounded down to
// the nearest hour"), so a template's exact epoch (e.g. 1784632175) reads back as the
// hour floor (1784631600) — a false declared drift. Compare by hour-floor equality; a
// genuine expiry change to a DIFFERENT hour still differs.
export const EPOCH_HOUR_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::AppSync::ApiKey': new Set(['Expires']),
};
export function isEpochHourEqual(a: unknown, b: unknown): boolean {
  const sec = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? Math.floor(n / 3600) : undefined;
  };
  const ha = sec(a);
  const hb = sec(b);
  return ha !== undefined && hb !== undefined && ha === hb;
}

// Per-type property paths where a value is a DNS FQDN whose trailing `.` is
// OPTIONAL and semantically meaningless: AWS::Route53::HostedZone `Name` is declared
// `example.com` in the template but Cloud Control returns it `example.com.` (the
// root-anchored form), which a positional diff reports as false drift on every zone.
// Equal once a single trailing dot is stripped from each side, so a genuinely
// different zone name still differs. (The RecordSet override reader already aligns its
// own Name/DNSName via alignTrailingDot; HostedZone is CC-native, handled here.)
export const TRAILING_DOT_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::Route53::HostedZone': new Set(['Name']),
};
export function isTrailingDotEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const strip = (s: string): string => (s.endsWith('.') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

// Per-type property paths where AWS RESOLVES a partial (major/minor) version the
// template declares to the full patch version it actually provisions (R130: RDS
// DBInstance `EngineVersion` declared `"8.0"` reads back `"8.0.45"`; the engine
// auto-selects the latest patch within the declared track). The declared value is a
// dotted-segment PREFIX of the live value — a deliberately narrow rule, NOT a generic
// string prefix: both sides must be dot-separated version strings and the declared
// segments must each EQUAL the leading live segments, so `"8.0"` matches `"8.0.45"`
// but `"8.0"` never matches `"8.05"` (segment boundary) and `"8.1"` never matches
// `"8.0.45"` (a genuine track change still differs). Observed-only entries; the drift
// path is the dotted path from calculateResourceDrift.
export const VERSION_PREFIX_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::RDS::DBInstance': new Set(['EngineVersion']),
  // Aurora clusters resolve a partial track the same way (declared `"8.0"` /
  // `"5.7.mysql_aurora.2"` reads back the full provisioned patch version).
  'AWS::RDS::DBCluster': new Set(['EngineVersion']),
  // Live-observed on a fresh neptune-rich deploy: Neptune accepts a major.minor
  // EngineVersion (declared `"1.3"`) and provisions the latest patch in that track,
  // reading back the concrete 4-segment version (`"1.3.5.0"`) — the same partial->
  // concrete shape as RDS. A genuine track change still differs (the leading-run
  // check fails). MSK KafkaVersion is NOT added: MSK validates KafkaVersion against
  // an exact supported-version list and rejects a partial, so declared == live.
  'AWS::Neptune::DBCluster': new Set(['EngineVersion']),
  // Live-observed on a fresh docdb-version-fp deploy: Amazon DocumentDB accepts a
  // partial EngineVersion (declared `"5.0"`) and provisions the concrete patch version,
  // reading back `"5.0.0"` — the same partial->concrete shape as RDS/Aurora/Neptune.
  // A genuine version change still differs (the leading-run check fails).
  'AWS::DocDB::DBCluster': new Set(['EngineVersion']),
};
export function isVersionPrefixMatch(declared: unknown, live: unknown): boolean {
  if (typeof declared !== 'string' || typeof live !== 'string') return false;
  if (declared.length === 0 || live.length === 0) return false;
  const dSegs = declared.split('.');
  const lSegs = live.split('.');
  // the declared track must be a leading run of segments of the live full version,
  // and strictly shorter (an exact-equal value isn't drift and never reaches here).
  if (dSegs.length >= lSegs.length) return false;
  return dSegs.every((seg, i) => seg === lSegs[i]);
}

// Per-type property paths where the template declares the literal sentinel
// `"LATEST"` and AWS resolves it to whatever concrete version is current
// (Fargate `PlatformVersion`: declared `"LATEST"` reads back the provisioned
// `"1.4.0"`). "Use the latest" IS satisfied by any concrete version, so a
// declared `"LATEST"` against a non-empty live string is not drift — reporting
// it is a false positive every Fargate user who pins PlatformVersion hits. A
// deliberately narrow rule: ONLY the exact sentinel `"LATEST"` folds (a declared
// CONCRETE version like `"1.3.0"` still compares normally, so a genuine pin
// change surfaces). Observed live on the ecs-taskset-rich fixture.
export const LATEST_SENTINEL_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::ECS::Service': new Set(['PlatformVersion']),
  'AWS::ECS::TaskSet': new Set(['PlatformVersion']),
};
export function isLatestSentinelMatch(declared: unknown, live: unknown): boolean {
  // only the literal sentinel folds; the live side must be a non-empty concrete
  // string (a missing/empty live value is a different, real divergence).
  return declared === 'LATEST' && typeof live === 'string' && live.length > 0;
}

// PEM-armored values (R125: CloudFront PublicKey EncodedKey; certificate/key
// bodies generally) round-trip through AWS with surrounding whitespace added or
// dropped — most commonly a trailing newline the service appends after the
// `-----END …-----` line. Whitespace around a PEM block carries no meaning, so
// two PEM-armored scalars are equal once outer whitespace is trimmed and line
// endings normalized. BOTH sides must be PEM-armored (a BEGIN and an END marker),
// so a genuine key/certificate change still differs and non-PEM strings are never
// touched — same equality-gated, fail-closed philosophy as the helpers above.
const PEM_RE = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/;
export function isPemEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!PEM_RE.test(a) || !PEM_RE.test(b)) return false;
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b);
}

// CloudFormation's GetTemplate API is LOSSY for non-ASCII: every non-ASCII codepoint in
// a string literal stored in the deployed template is returned as a literal `?` (observed
// live — an SSM Parameter `Value: áéíóúABC` comes back `?????ABC`, one `?` per
// non-ASCII character). We fetch the DECLARED side via GetTemplate, so it is corrupted
// while the LIVE side (read from the service) is intact — a GUARANTEED false `declared`
// drift on every check, with no out-of-band change. When the live value, with each of its
// non-ASCII codepoints masked to `?`, exactly equals the declared value (so the ASCII
// characters and the length match, and the declared side carries ≥1 `?` standing in for a
// non-ASCII char the API ate), the declared value is unknowable from GetTemplate and the
// difference cannot be confirmed as drift. Length-exact and equality-gated: a genuine
// change that alters an ASCII char or the string length still differs and is reported;
// only a same-length non-ASCII-only edit (inherently invisible through GetTemplate) is
// missed. Astral codepoints (emoji) mask as one `?` here — if CFn emitted two, the
// comparison simply falls through and the value is reported (fail-toward-reporting).
export function isCfnTemplateNonAsciiMask(declared: unknown, live: unknown): boolean {
  if (typeof declared !== 'string' || typeof live !== 'string') return false;
  if (!declared.includes('?')) return false; // no masked position → not this case
  let masked = '';
  let sawNonAscii = false;
  for (const ch of live) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) {
      masked += '?';
      sawNonAscii = true;
    } else {
      masked += ch;
    }
  }
  return sawNonAscii && masked === declared;
}

// AWS resource-id / ARN lists (SubnetIds, SecurityGroupIds, VPCSecurityGroups, ...)
// are UNORDERED sets too, but unlike tags their elements
// are bare scalars, so the tag canonicalizer doesn't touch them and a positional
// diff reports false drift whenever CDK's order != AWS's. Sort only arrays whose
// EVERY element is an AWS resource id (`subnet-0ab…`, `sg-…`, `vpc-…`) or an ARN —
// (AvailabilityZones name/id lists are the same kind of set but lack the hex suffix;
// they are handled by the parallel isAvailabilityZone test below) —
// these are never order-significant. A plain scalar list like an enum sequence
// (["a","b"]) is left untouched, so genuinely ordered lists keep reporting drift.
// KNOWN LIMITATION: the heuristic is shape-based, so a list whose every element is
// an arbitrary `prefix-<hex-looking-suffix>` name (e.g. `["svc-abc123","svc-def456"]`)
// would also be sorted even if that array were order-significant. No such
// order-significant AWS property is known; the trade-off favors killing the very
// common id-set false drift over guarding a hypothetical one.
const ID_RE = /^[a-z][a-z0-9]*-[0-9a-f]{6,}$/;
const isIdLike = (s: unknown): boolean =>
  typeof s === 'string' && (s.startsWith('arn:') || ID_RE.test(s));

// Availability-Zone NAMES (`us-east-1a`, `ap-northeast-1c`, `us-gov-east-1b`) and AZ
// IDs (`use1-az1`, `apne1-az2`) have NO hex suffix, so ID_RE above does NOT match them
// — yet an AvailabilityZones / PreferredAvailabilityZones / PreferredCacheClusterAZs
// list is a SET (which AZs to span, order carries no meaning) that AWS returns in
// account/assignment order, NOT declared order (observed live: an RDS DBCluster reads
// back `[us-east-1c, us-east-1a, us-east-1b]`). Without folding, a positional compare
// false-flags a declared AZ list, and a recorded undeclared AZ list re-read in a
// different order false-drifts as "changed since record". An array whose EVERY element
// is an AZ name/id is safe to sort (no AZ list is order-significant). Same content-based,
// no-per-type-table philosophy as isIdLike.
const AZ_NAME_RE = /^[a-z]{2}-[a-z]+(-[a-z]+)?-\d{1,2}[a-z]$/;
const AZ_ID_RE = /^[a-z]{3,5}\d-az\d+$/;
const isAvailabilityZone = (s: unknown): boolean =>
  typeof s === 'string' && (AZ_NAME_RE.test(s) || AZ_ID_RE.test(s));

// HTTP-method enum sets (CloudFront DefaultCacheBehavior.AllowedMethods /
// CachedMethods, ...) are UNORDERED: the template lists them in one order, AWS
// returns them in another, so a positional diff reports false drift. The verb set
// is closed and order-insensitive wherever AWS records it, so an array whose EVERY
// element is one of these verbs is safe to sort. (Same content-based philosophy as
// isIdLike: no per-type table, just a value-shape test.)
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const isHttpMethod = (s: unknown): boolean => typeof s === 'string' && HTTP_METHODS.has(s);

// THE one known order-SIGNIFICANT id/ARN array: AWS::Lambda::Function.Layers is a
// list of layer-version ARNs where order is meaningful — later layers overlay files
// from earlier ones, so swapping two layers changes the function's merged content.
// Every other id/ARN array (SubnetIds, SecurityGroupIds, …) is a set, so the generic
// sort above is safe; a layer ARN is uniquely shaped
// (`arn:aws…:lambda:<region>:<acct>:layer:<name>:<version>`), so detect it by shape
// and leave any array containing one UNSORTED — an out-of-band layer reorder then
// surfaces as drift instead of being silently suppressed (the false negative the
// blanket sort otherwise produced). Same content-based, no-per-type-table philosophy.
const LAMBDA_LAYER_ARN_RE = /^arn:aws[a-z-]*:lambda:[^:]*:\d*:layer:/;
const hasOrderSignificantId = (arr: unknown[]): boolean =>
  arr.some((s) => typeof s === 'string' && LAMBDA_LAYER_ARN_RE.test(s));

export function canonicalizeIdArraysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeIdArraysDeep);
    if (
      mapped.length > 1 &&
      !hasOrderSignificantId(mapped) &&
      (mapped.every(isIdLike) || mapped.every(isHttpMethod) || mapped.every(isAvailabilityZone))
    )
      return [...(mapped as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = canonicalizeIdArraysDeep(val);
    return out;
  }
  return v;
}

// Per-type SCALAR-array props AWS treats as UNORDERED SETS but whose elements
// match none of the content-shape canonicalizers above (not ids/ARNs, not HTTP
// verbs, no identity field): the service stores a set and echoes it in ITS
// canonical order, so a positional diff against the template's order is false
// drift on every check. Entries are added only when OBSERVED live (R74: a fresh
// Cognito UserPoolClient deploy reported all three as declared drift with
// identical elements). Consulted by classify's declared loop, equality-gated:
// the two sides must be the SAME multiset — a genuine element change still
// reports.
// Per-type path patterns for a `[{ParameterName, ParameterValue}]` array that the
// service treats as an IDENTITY-KEYED SET (keyed by ParameterName) AND default-fills:
// the template declares a SUBSET, the service REORDERS the set and INJECTS its own
// server defaults. Kinesis Firehose's processor `Parameters` is the case (observed live
// on a fresh firehose-processors-rich deploy: a Lambda processor declared
// [RoleArn, BufferSizeInMBs, BufferIntervalInSeconds, LambdaArn] reads back reordered as
// [LambdaArn, NumberOfRetries, RoleArn, BufferSizeInMBs, BufferIntervalInSeconds] — the
// service injected NumberOfRetries=3). ParameterName is not in IDENTITY_FIELDS, so the
// whole array false-flags as one `declared` drift. Matched against the dotted drift path
// (which carries the Processors array index, e.g. `…Processors.0.Parameters`).
export const PARAMETER_NAME_SUBSET_PATHS: Record<string, RegExp> = {
  'AWS::KinesisFirehose::DeliveryStream': /(^|\.)Processors\.\d+\.Parameters$/,
};
// Align a declared `[{ParameterName,ParameterValue}]` array to a live one BY
// ParameterName. Returns the live-only entries (server-injected / out-of-band params the
// template never declared) when every DECLARED param is present in live with an equal
// value (declared ⊆ live, reorder-insensitive) — the caller suppresses the false
// whole-array `declared` drift and surfaces the live-only entries as undeclared
// inventory (fail-closed, recorded). Returns null when a declared param is MISSING from
// live or its value differs (a genuine declared drift the caller must keep), or when
// either side is not a pure ParameterName/ParameterValue array.
export function alignParameterNameSubset(declared: unknown, live: unknown): unknown[] | null {
  if (!Array.isArray(declared) || !Array.isArray(live)) return null;
  const toMap = (arr: unknown[]): Map<string, unknown> | null => {
    const m = new Map<string, unknown>();
    for (const e of arr) {
      if (
        !e ||
        typeof e !== 'object' ||
        typeof (e as Record<string, unknown>).ParameterName !== 'string'
      )
        return null;
      const r = e as Record<string, unknown>;
      m.set(r.ParameterName as string, r.ParameterValue);
    }
    return m;
  };
  const dm = toMap(declared);
  const lm = toMap(live);
  if (!dm || !lm) return null;
  for (const [name, dVal] of dm) {
    if (!lm.has(name)) return null;
    const lVal = lm.get(name);
    if (dVal !== lVal && !isStringlyEqualScalar(dVal, lVal)) return null;
  }
  return live.filter((e) => !dm.has((e as Record<string, unknown>).ParameterName as string));
}

export const UNORDERED_ARRAY_PROPS: Record<string, ReadonlySet<string>> = {
  'AWS::Cognito::UserPoolClient': new Set([
    'AllowedOAuthFlows',
    'AllowedOAuthScopes',
    'ExplicitAuthFlows',
    // Live-observed on a fresh cognito-callbackurls deploy: Cognito stores the
    // CallbackURLs / LogoutURLs as SETS and echoes them in its own canonical order
    // (declared [zeta,alpha,mike] read back [alpha,mike,zeta]) — a positional compare
    // false-drifts the URL list with identical elements. Same set-reorder class as the
    // sibling OAuth lists above; a genuine URL add/remove still changes the multiset.
    'CallbackURLs',
    'LogoutURLs',
  ]),
  // R84 (observed live on a fresh harvest6 deploy): WAFv2 stores the IP address
  // set and echoes it in its own canonical order, so a fresh deploy reports the
  // declared CIDR list as drift with identical elements in a different order.
  'AWS::WAFv2::IPSet': new Set(['Addresses']),
  // Live-observed on a fresh route53-multivalue deploy: a DNS RecordSet's multiple
  // ResourceRecords are a SET (a multi-value A/TXT/MX record — DNS resolvers treat
  // the values as unordered), and Route53 echoes them in its own canonical order
  // (declared TXT [zeta,alpha,mike] read back [mike,alpha,zeta]; A IPs reordered).
  // A positional compare false-drifts identical value sets; a genuine value
  // add/remove still changes the multiset. (Weighted/latency routing uses separate
  // RecordSets with SetIdentifier, not ordered ResourceRecords, so this is FP-safe.)
  'AWS::Route53::RecordSet': new Set(['ResourceRecords']),
  // Live-observed on a fresh codedeploy-deploymentgroup-readgap deploy: a deployment
  // group's AutoRollbackConfiguration.Events is a SET of rollback-trigger enums that
  // CodeDeploy echoes SORTED alphabetically, not in template order (declared
  // [DEPLOYMENT_STOP_ON_ALARM, DEPLOYMENT_FAILURE] read back [DEPLOYMENT_FAILURE,
  // DEPLOYMENT_STOP_ON_ALARM]) — a positional compare false-drifts the identical event
  // set. A genuine event add/remove still changes the multiset. (The sibling
  // TriggerConfigurations[].TriggerEvents set was observed to PRESERVE template order on
  // the same deploy, so it is deliberately NOT folded.) The path is nested but the
  // declared-loop suppression keys on the full dotted `d.path`, so the dotted key works.
  'AWS::CodeDeploy::DeploymentGroup': new Set(['AutoRollbackConfiguration.Events']),
  // NOTE: ECS TaskDefinition `RequiresCompatibilities` and Route53 HealthCheck
  // `HealthCheckConfig.Regions` (both live-observed as AWS-sorted enum sets, #365) are
  // NO LONGER listed here — their CFn schema marks them `insertionOrder: false`, so the
  // schema-driven `SchemaInfo.unorderedScalarPaths` fold (classify) now covers them (and
  // any other insertionOrder:false scalar set) without a per-type entry. Only sets the
  // schema leaves `insertionOrder:true`/absent — which AWS STILL sorts — need a manual
  // entry below (the schema flag is unreliable: most sorted sets are default-true).
  // Live-observed on a fresh rds-logexports-reorder deploy: RDS echoes a DB instance's
  // EnableCloudwatchLogsExports (the SET of log types to ship to CloudWatch — error/
  // general/slowquery/audit for MySQL) SORTED alphabetically, not in template order
  // (declared [slowquery, general, error] read back [error, general, slowquery]). A
  // positional compare false-drifts the identical log-type set on every check — and a
  // huge fraction of RDS users enable DB logs. A genuine log-type add/remove still
  // changes the multiset. The tokens aren't ids/ARNs/HTTP/AZ, so the generic
  // canonicalizeIdArraysDeep leaves them untouched. The SAME property exists on the
  // whole RDS family (DBCluster/Aurora, Neptune DBCluster, DocDB DBCluster) and is a
  // log-type SET on each — folded for all four (equality-gated, so harmless on any that
  // happen to preserve order). DBInstance is the live-proven case.
  'AWS::RDS::DBInstance': new Set(['EnableCloudwatchLogsExports']),
  'AWS::RDS::DBCluster': new Set(['EnableCloudwatchLogsExports']),
  'AWS::Neptune::DBCluster': new Set(['EnableCloudwatchLogsExports']),
  'AWS::DocDB::DBCluster': new Set(['EnableCloudwatchLogsExports']),
};

// True when both values are scalar arrays containing the same multiset of
// primitives (order-insensitive equality). Objects/nested arrays never match —
// those have their own canonicalizers.
export function isEqualUnorderedScalarSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const scalar = (v: unknown): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (!a.every(scalar) || !b.every(scalar)) return false;
  const sort = (arr: unknown[]): string[] => arr.map((v) => `${typeof v}:${String(v)}`).sort();
  const sa = sort(a);
  const sb = sort(b);
  return sa.every((v, i) => v === sb[i]);
}

// Per-type OBJECT-array props AWS treats as UNORDERED SETS whose element objects
// carry NO single identity field (so canonicalizeTagListsDeep cannot key them) and
// are NOT scalar (so isEqualUnorderedScalarSet does not apply): EC2 SecurityGroup
// ingress/egress rules are the case (R88) — a set of {CidrIp,IpProtocol,FromPort,
// ToPort,Description,...} rules AWS returns in a different order than declared, which
// a positional diff reports as false drift on every field of every shifted rule.
// A blanket "sort every identity-less object array" is unsafe (some object arrays ARE
// order-significant — CloudFront cache behaviors by precedence, etc.), so this stays a
// per-type opt-in. Consulted by classify's declared loop, which sorts BOTH sides by
// canonical JSON before the positional diff — a genuine rule change still differs.
export const UNORDERED_OBJECT_ARRAY_PROPS: Record<string, ReadonlySet<string>> = {
  'AWS::EC2::SecurityGroup': new Set(['SecurityGroupIngress', 'SecurityGroupEgress']),
  // Cognito UserPoolResourceServer `Scopes` is a SET of {ScopeName, ScopeDescription}
  // OAuth scopes that AWS echoes SORTED by ScopeName, not in template order (declared
  // [zeta.write, alpha.read, mike.admin] reads back [alpha.read, mike.admin, zeta.write]),
  // so a positional compare false-flags every shifted scope's ScopeName AND
  // ScopeDescription as declared drift on a freshly recorded resource server. The
  // element key `ScopeName` is NOT one of canonicalizeTagListsDeep's IDENTITY_FIELDS
  // (Key/Id/AttributeName/IndexName/Name), so that keyed canonicalizer can't align it —
  // hence the per-type opt-in. Sorting both sides by canonical JSON aligns equal scopes;
  // a genuine scope add/remove/change still differs. Observed live on a fresh
  // cognito-userpool-sets deploy. (The sibling UserPool `AliasAttributes` set was tested
  // in the SAME deploy with a deliberately non-sorted list and Cognito PRESERVED its
  // order, so it is NOT folded — observed-only.)
  'AWS::Cognito::UserPoolResourceServer': new Set(['Scopes']),
  // ListenerRule `Conditions` is a SET keyed by Field (path-pattern / host-header /
  // http-header / …) that AWS returns REORDERED relative to the template, so a
  // positional compare false-flags every condition. Sorting both sides by canonical
  // JSON aligns them by Field (the first sorted key), and a genuine condition change
  // still differs. (`Actions` is NOT listed — its element Order is semantic.) The live
  // model also adds a legacy top-level `Values` mirror to each condition; that is
  // handled separately as undeclared nested inventory (subset descent walks only the
  // declared *Config keys). Observed live on a fresh elbv2-listenerrule-rich deploy.
  'AWS::ElasticLoadBalancingV2::ListenerRule': new Set(['Conditions']),
  // An IAM principal's inline `Policies` is a SET of {PolicyName, PolicyDocument}
  // that AWS returns SORTED by PolicyName, not in template order: a role declaring
  // [readObjects, describeOnly] reads back [describeOnly, readObjects] (alphabetical),
  // so a positional compare false-flags every shifted policy's PolicyName AND its
  // whole PolicyDocument as declared drift on a freshly recorded role. The element key
  // `PolicyName` is NOT one of canonicalizeTagListsDeep's IDENTITY_FIELDS
  // (Key/Id/AttributeName/IndexName/Name), so that keyed canonicalizer can't align it —
  // hence the per-type opt-in. Sorting runs AFTER canonicalizeForCompare, so each
  // element's PolicyDocument is already statement-canonicalized; sorting both sides by
  // canonical JSON then aligns equal policies and a genuine policy add/remove/change
  // still differs. Observed live on a fresh iam-permboundary-rich deploy. The identical
  // inline-policy-set shape lives on IAM User and Group (CFn `Policies` of the same
  // {PolicyName, PolicyDocument} element) — folded by the same set-semantics reasoning.
  'AWS::IAM::Role': new Set(['Policies']),
  'AWS::IAM::User': new Set(['Policies']),
  'AWS::IAM::Group': new Set(['Policies']),
  // A Redshift ClusterParameterGroup's `Parameters` is a SET of {ParameterName,
  // ParameterValue} that AWS returns SORTED by ParameterName, not in template order: a
  // group declaring [require_ssl, enable_user_activity_logging, max_concurrency_scaling
  // _clusters] reads back [enable_user_activity_logging, max_concurrency_scaling_clusters,
  // require_ssl] (alphabetical), so a positional compare false-flags every shifted
  // parameter's ParameterName AND ParameterValue as declared drift on a freshly recorded
  // group. ParameterName is NOT an IDENTITY_FIELD, so only the per-type fold aligns it.
  // Sorting both sides by canonical JSON aligns equal parameters; a genuine value change
  // still differs. Observed live on a fresh redshift-paramgroup-reorder deploy. (The
  // sibling RDS DB/DBClusterParameterGroup `Parameters` is a free-form Map<String,String>,
  // not this array shape, so it is key-canonicalized — not folded here.)
  'AWS::Redshift::ClusterParameterGroup': new Set(['Parameters']),
  // An EC2 Auto Scaling group's inline `LifecycleHookSpecificationList` is a SET of
  // hooks AWS echoes SORTED by LifecycleHookName, not in template order (declared
  // [zeta-terminate, alpha-launch] reads back [alpha-launch, zeta-terminate]), so a
  // positional compare false-flags every field of every shifted hook as declared drift
  // on a freshly recorded ASG. The element key `LifecycleHookName` is NOT one of
  // canonicalizeTagListsDeep's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so
  // that keyed canonicalizer can't align it — hence the per-type opt-in. Sorting both
  // sides by canonical JSON aligns equal hooks; a genuine hook add/remove/change still
  // differs. Observed live on a fresh asg-lifecyclehook-inline deploy. (This is the
  // ASG's OWN inline hook list — distinct from the standalone AWS::AutoScaling::
  // LifecycleHook resource the autoscaling-lifecyclehook-rich fixture covers.)
  'AWS::AutoScaling::AutoScalingGroup': new Set(['LifecycleHookSpecificationList']),
  // A multi-region Secret's `ReplicaRegions` is a SET of {Region, KmsKeyId} that Secrets
  // Manager echoes SORTED by Region, not in template order (declared [us-west-2,
  // eu-west-1] reads back [eu-west-1, us-west-2]), so a positional compare false-flags
  // every shifted replica's Region as declared drift on a freshly recorded secret. The
  // element key `Region` is NOT one of canonicalizeTagListsDeep's IDENTITY_FIELDS
  // (Key/Id/AttributeName/IndexName/Name), so that keyed canonicalizer can't align it —
  // hence the per-type opt-in. Sorting both sides by canonical JSON aligns equal replicas;
  // a genuine region add/remove still differs. Observed live on a fresh
  // secret-replica-regions deploy.
  'AWS::SecretsManager::Secret': new Set(['ReplicaRegions']),
  // An ElastiCache CacheCluster's `LogDeliveryConfigurations` is a SET of {LogType,
  // LogFormat, DestinationType, DestinationDetails} that AWS echoes SORTED by LogType,
  // not in template order (declared [slow-log, engine-log] reads back [engine-log,
  // slow-log] alphabetically), so a positional compare false-flags every field of every
  // shifted config — LogType AND the resolved destination LogGroup — as declared drift on
  // a freshly recorded cluster. The element key `LogType` is NOT one of
  // canonicalizeTagListsDeep's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so
  // that keyed canonicalizer can't align it — hence the per-type opt-in. Sorting both
  // sides by canonical JSON aligns equal configs; a genuine destination/format change
  // still differs. Observed live on a fresh elasticache-logdelivery deploy (slow-log +
  // engine-log to CloudWatch Logs). The same shape exists on AWS::ElastiCache::
  // ReplicationGroup (`LogDeliveryConfigurations` of identical {LogType, …} elements) —
  // folded by the same set-semantics reasoning.
  'AWS::ElastiCache::CacheCluster': new Set(['LogDeliveryConfigurations']),
  'AWS::ElastiCache::ReplicationGroup': new Set(['LogDeliveryConfigurations']),
};

// Per-type NESTED array paths AWS returns reordered (dotted from the resource
// root, e.g. `ContentPolicyConfig.FiltersConfig`). This is the nested twin of
// UNORDERED_OBJECT_ARRAY_PROPS, which only reaches TOP-LEVEL array keys. Mostly
// object-array sets, but a nested SCALAR set works too (DynamoDB NonKeyAttributes):
// sortNestedObjectArrays/sortUnorderedObjectArray sort by each element's canonical
// JSON, which orders scalars as well. Bedrock
// Guardrail nests its policy-config sets one level deep and AWS canonicalizes the
// element order (the content filters come back sorted by an internal order, not the
// template's declaration order), so a positional compare false-flags a reordered-but-
// identical set as several declared drifts. Each listed array is a SET keyed by an
// identity field (FiltersConfig/PiiEntitiesConfig by Type, TopicsConfig/RegexesConfig
// by Name, WordsConfig by Text) so sorting both sides by canonical JSON aligns equal
// elements positionally; a genuine element add/remove/change still differs after the
// sort. Observed live on a fresh bedrock-guardrail-rich deploy.
export const UNORDERED_NESTED_OBJECT_ARRAY_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::Bedrock::Guardrail': new Set([
    'ContentPolicyConfig.FiltersConfig',
    'TopicPolicyConfig.TopicsConfig',
    'WordPolicyConfig.WordsConfig',
    'WordPolicyConfig.ManagedWordListsConfig',
    'SensitiveInformationPolicyConfig.PiiEntitiesConfig',
    'SensitiveInformationPolicyConfig.RegexesConfig',
  ]),
  // ECS reorders a container's `PortMappings` relative to the template: a
  // task definition declaring ports [8080, 443, 80] reads back [443, 8080, 80] (the
  // mappings are a SET — order carries no meaning), so a positional compare false-flags
  // every shifted mapping as declared drift on a freshly deployed + recorded task def.
  // The path crosses the `ContainerDefinitions` ARRAY (sortNestedObjectArrays recurses
  // element-wise into it), so this aligns the PortMappings set INSIDE each container.
  // Sorting both sides by canonical JSON keys on ContainerPort (the first key), so equal
  // mappings land in the same slot and a genuine port add/remove/change still differs.
  // Observed live on a fresh ecs-taskdef-caps deploy (capabilities/ulimits/dnsSearch on
  // the same container were NOT reordered — only PortMappings). `VolumesFrom` (a SET
  // keyed by SourceContainer) is reordered the same way — declared [logger, app] reads
  // back [app, logger] — observed on a fresh ecs-taskdef-mounts deploy; MountPoints and
  // SystemControls on the same container were NOT reordered, so they are not listed.
  // A container's legacy bridge-mode `Links` is a nested SCALAR set (`name:alias`
  // strings) that ECS echoes SORTED alphabetically, not in template order (declared
  // [logger:log, init:setup] reads back [init:setup, logger:log]), so a positional
  // compare false-flags the identical link set on every check of a freshly recorded
  // task def. The values aren't id/ARN/HTTP/AZ-shaped, so canonicalizeIdArraysDeep
  // leaves them; sortNestedObjectArrays sorts a scalar array by canonical JSON, so the
  // same machinery that aligns PortMappings aligns it. A genuine link add/remove still
  // changes the multiset. Observed live on a fresh ecs-taskdef-sets deploy (DependsOn,
  // ExtraHosts, DockerSecurityOptions, DnsServers, and task-level PlacementConstraints
  // were declared non-sorted in the SAME deploy and ECS PRESERVED their order, so they
  // are deliberately NOT listed — observed-only).
  'AWS::ECS::TaskDefinition': new Set([
    'ContainerDefinitions.PortMappings',
    'ContainerDefinitions.VolumesFrom',
    'ContainerDefinitions.Links',
  ]),
  // DynamoDB sorts an INCLUDE-projection `NonKeyAttributes` set into its own canonical
  // order: declared ["zeta","alpha","mike","bravo"] reads back reordered, a positional
  // compare false-flags the whole set. This is a nested SCALAR set (plain attribute names
  // — not id/ARN-shaped, so canonicalizeIdArraysDeep leaves it) nested under the
  // (Global|Local)SecondaryIndexes ARRAY; sortNestedObjectArrays sorts scalar arrays by
  // canonical JSON too, so the same machinery aligns it. A genuine attribute add/remove
  // still changes the multiset. The GSI path was observed live on a fresh
  // ddb-gsi-projection deploy; the LSI path and the AWS::DynamoDB::GlobalTable (TableV2)
  // GSI *and* LSI paths — the identical projection shape on a Table's LSI and on the
  // GlobalTable type — were observed live on a fresh ddb-nested-sets deploy (declared
  // ["yankee","bravo","oscar","delta"] read back ["oscar","delta","yankee","bravo"], etc.).
  'AWS::DynamoDB::Table': new Set([
    'GlobalSecondaryIndexes.Projection.NonKeyAttributes',
    'LocalSecondaryIndexes.Projection.NonKeyAttributes',
  ]),
  'AWS::DynamoDB::GlobalTable': new Set([
    'GlobalSecondaryIndexes.Projection.NonKeyAttributes',
    'LocalSecondaryIndexes.Projection.NonKeyAttributes',
  ]),
  // An ALB ListenerRule path-pattern condition's `Values` is a SET of patterns OR'd
  // together (order carries no meaning — a request matches if ANY value matches), and
  // ALB returns them in its OWN canonical order: declared ["/zebra/*","/alpha/*",
  // "/mango/*"] reads back ["/alpha/*","/zebra/*","/mango/*"], so a positional compare
  // false-flags the whole set. The set is nested one object level (PathPatternConfig)
  // under the `Conditions` ARRAY, so sortNestedObjectArrays recurses element-wise and
  // sorts the scalar Values array. Observed live on a fresh elbv2-rule-values deploy.
  // (HostHeaderConfig.Values was tested in the SAME deploy with a deliberately
  // non-sorted set and ALB PRESERVED its order, so it is NOT listed — observed-only.)
  // `Conditions` is ALSO an UNORDERED_OBJECT_ARRAY_PROPS set; classify composes the
  // two — inner Values sorted first, then the Conditions array sorted by canonical JSON.
  // A source-ip condition's `SourceIpConfig.Values` (a CIDR set) and an http-header
  // condition's `HttpHeaderConfig.Values` (a header-value-string set) are reordered the
  // same way — observed live on a fresh elbv2-rule-conditions deploy (declared
  // [10.3/16, 10.1/16, 10.2/16] read back [10.3/16, 10.2/16, 10.1/16]; declared
  // [zeta, alpha, mike] read back [zeta, mike, alpha]). Both are OR'd value SETS (a
  // request matches if ANY value matches), so order carries no meaning. CIDRs and
  // header-value strings aren't id/ARN/HTTP/AZ-shaped, so canonicalizeIdArraysDeep leaves
  // them. (`QueryStringConfig.Values` was reordered in the SAME deploy too, but its
  // elements are {Key, Value} pairs — Key IS an IDENTITY_FIELD, so canonicalizeTagListsDeep
  // already aligns them; `HttpRequestMethodConfig.Values` is a set of HTTP verbs the
  // generic isHttpMethod sort folds — neither needs a table entry. HostHeaderConfig.Values
  // was observed order-PRESERVING in the earlier elbv2-rule-values deploy.)
  'AWS::ElasticLoadBalancingV2::ListenerRule': new Set([
    'Conditions.PathPatternConfig.Values',
    'Conditions.SourceIpConfig.Values',
    'Conditions.HttpHeaderConfig.Values',
  ]),
  // A BackupSelection's tag-based membership `BackupSelection.ListOfTags` is a SET of
  // {ConditionKey, ConditionType, ConditionValue} that AWS Backup echoes SORTED by
  // ConditionKey, not in template order (declared [zeta, alpha, mike] reads back
  // [alpha, mike, zeta]), so a positional compare false-flags every shifted condition's
  // ConditionKey AND ConditionValue as declared drift on a freshly recorded selection.
  // ConditionKey is NOT an IDENTITY_FIELD (Key/Id/AttributeName/IndexName/Name), so the
  // keyed canonicalizer can't align it. The set is nested one OBJECT level under the
  // top-level `BackupSelection` key (not under an array), like Bedrock Guardrail's
  // ContentPolicyConfig.FiltersConfig — sortNestedObjectArrays sorts the object array by
  // canonical JSON, aligning equal conditions; a genuine condition add/remove/change
  // still differs. Observed live on a fresh backup-selection deploy. (The sibling
  // `BackupSelection.Conditions.StringEquals` — the newer condition shape — was declared
  // non-sorted in the SAME deploy and AWS PRESERVED its order, so it is deliberately NOT
  // listed — observed-only.)
  'AWS::Backup::BackupSelection': new Set(['BackupSelection.ListOfTags']),
  // An EC2 Auto Scaling group's `MetricsCollection[].Metrics` (the group metrics to
  // enable) and `NotificationConfigurations[].NotificationTypes` (the lifecycle events to
  // publish to SNS) are scalar enum SETs nested under their respective arrays that AWS
  // echoes SORTED alphabetically, not in template order (declared
  // [GroupTotalInstances, GroupDesiredCapacity, GroupMaxSize, GroupMinSize] reads back
  // [GroupDesiredCapacity, GroupMaxSize, GroupMinSize, GroupTotalInstances]; declared
  // [TERMINATE, LAUNCH, LAUNCH_ERROR] reads back [LAUNCH, LAUNCH_ERROR, TERMINATE]), so a
  // positional compare false-flags the identical set as declared drift on a freshly
  // recorded ASG. The tokens aren't id/ARN/HTTP/AZ-shaped, so canonicalizeIdArraysDeep
  // leaves them; the schema marks both insertionOrder:false but the scalar auto-fold skips
  // array-crossing (`*`) paths, so they need this per-type entry. sortNestedObjectArrays
  // crosses the MetricsCollection / NotificationConfigurations array and sorts the inner
  // scalar set; a genuine metric/event add/remove still differs. Observed live on a fresh
  // asg-notification-metrics deploy.
  'AWS::AutoScaling::AutoScalingGroup': new Set([
    'MetricsCollection.Metrics',
    'NotificationConfigurations.NotificationTypes',
  ]),
};

// Return a deep clone of `value` (a declared/live property subtree rooted at one
// top-level key) with the object array at each of `subPaths` (dotted, RELATIVE to that
// root) sorted into canonical order. Applied to BOTH the declared and live side before
// the positional nested diff so a reordered-but-equal set aligns; a non-array or absent
// path is left untouched, and a genuine element change still differs after the sort.
export function sortNestedObjectArrays(value: unknown, subPaths: readonly string[]): unknown {
  if (subPaths.length === 0 || value === null || typeof value !== 'object') return value;
  // A sub-path may cross an ARRAY (ECS `ContainerDefinitions.PortMappings`: the parent
  // ContainerDefinitions is itself an array, so PortMappings lives one level down inside
  // EACH element). Recurse element-wise, applying the same remaining sub-paths inside
  // every element, so the nested set is sorted within each container.
  if (Array.isArray(value)) return value.map((el) => sortNestedObjectArrays(el, subPaths));
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const sub of subPaths) {
    const segs = sub.split('.');
    let cur: Record<string, unknown> | undefined = clone;
    for (let i = 0; i < segs.length - 1 && cur; i++) {
      const next: unknown = cur[segs[i] as string];
      cur =
        next !== null && typeof next === 'object' ? (next as Record<string, unknown>) : undefined;
    }
    const last = segs[segs.length - 1] as string;
    if (cur && Array.isArray(cur[last])) cur[last] = sortUnorderedObjectArray(cur[last]);
  }
  return clone;
}

// Stable, key-order-insensitive JSON of a value (objects emit keys sorted), used as a
// total order to sort an unordered object array deterministically on both sides.
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// Sort an array by each element's canonical JSON (a no-op on non-arrays). Applied to
// BOTH the declared and live side of an UNORDERED_OBJECT_ARRAY_PROPS property so a
// reordered-but-equal rule set aligns positionally; equal elements (modulo key order)
// land in the same slot, so the subsequent element-wise diff sees no drift, while a
// genuinely changed rule still differs.
export function sortUnorderedObjectArray(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return [...v].sort((a, b) => {
    const ka = canonicalJson(a);
    const kb = canonicalJson(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// CFn has many "stringly-typed" fields: Glue Table `Parameters` is a
// `Map<String,String>`, ports/sizes are declared as `"5432"`, booleans come back as
// `"true"`. CDK sometimes emits the typed JSON form (boolean `true`, number `5432`)
// while AWS returns the string (`"true"` / `"5432"`) — a positional diff then reports
// false drift. Treat a primitive and its EXACT `String()` form as equal. Scalars only
// (never collapses objects/arrays); a genuine value change (`true` vs `"false"`,
// `5` vs `"6"`) still differs, so real drift is preserved.
//
// SCOPE: this scalar check runs in classify's declared loop on LEAF drift records.
// The drift-calculator reports a scalar-ARRAY mismatch as ONE parent-path record
// (value = the whole array), so this per-leaf check never sees the ELEMENTS of a
// typed `[80, 443]` vs live `["80", "443"]`. That array shape is handled by
// `isStringlyEqualScalarArray` (R23) below, which applies this same typed<->string
// collapse element-wise — so both the scalar and scalar-array forms are suppressed.
const DECIMAL_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function isStringlyEqualScalar(a: unknown, b: unknown): boolean {
  const prim = (v: unknown): v is boolean | number =>
    typeof v === 'boolean' || typeof v === 'number';
  const eq = (p: boolean | number, s: string): boolean => {
    if (String(p) === s) return true;
    // Numeric FORMATTING variants (R67): AWS returns decimal strings like "5.0"
    // for a declared number 5 (Budgets BudgetLimit.Amount). Numbers only, and the
    // string must be a plain decimal literal (no '' -> 0, no '0x10' = 16), so a
    // genuine value change still differs.
    return typeof p === 'number' && DECIMAL_RE.test(s.trim()) && Number(s) === p;
  };
  if (prim(a) && typeof b === 'string') return eq(a, b);
  if (prim(b) && typeof a === 'string') return eq(b, a);
  return false;
}

// R23: a scalar ARRAY whose elements are pairwise stringly-equal is not drift.
// CFn stringly-typed list fields (declared `[80, 443]` while AWS returns
// `["80", "443"]`, declared `[true]` vs live `["true"]`) surface from the
// drift-calculator as ONE parent-path record carrying the WHOLE array, so the
// per-leaf `isStringlyEqualScalar` above never compares the elements. This applies
// the same typed<->string collapse element-wise: positional (order-sensitive —
// unordered sets are handled by UNORDERED_ARRAY_PROPS), equal length + all scalars
// required, each pair equal either strictly or via `isStringlyEqualScalar`. A
// genuine element change (`[80, 443]` vs `["80", "8443"]`) still differs, so real
// drift is preserved.
export function isStringlyEqualScalarArray(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const scalar = (v: unknown): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (!a.every(scalar) || !b.every(scalar)) return false;
  return a.every((v, i) => v === b[i] || isStringlyEqualScalar(v, b[i]));
}

// A whole OBJECT/MAP whose only differences are typed<->string scalar coercions is
// not drift. A free-form `Map<String,String>` (Glue Table/Database `Parameters`,
// DockerLabels, Lambda env `Variables`, map `Tags`) whose KEYS contain the path
// grammar's separators (a Glue `projection.enabled` key) is emitted by the
// drift-calculator as ONE parent-path record carrying the WHOLE map — it never
// descends, so the per-leaf `isStringlyEqualScalar` never sees the values. CDK emits
// the typed JSON form for some values (boolean `projection.enabled: true`, a numeric
// `skip.header.line.count: 2`) while AWS stores every map value as a STRING
// (`"true"`, `"2"`), so a single such value makes the strict `deepEqual` fail and the
// whole map false-drifts. This recurses both sides key-by-key (order-insensitive),
// folding each leaf via the same typed<->string collapse. A genuinely
// added/removed key, or a real value change, still differs — so real drift is kept.
// Not Glue-specific: it folds the coercion for ANY whole-emitted free-form map.
export function isStringlyEqualDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isStringlyEqualScalar(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => isStringlyEqualDeep(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    return ak.every((k) => Object.hasOwn(bo, k) && isStringlyEqualDeep(ao[k], bo[k]));
  }
  return false;
}

// A1: trivially-empty/off values AWS returns for unset features. Objects recurse:
// a struct whose EVERY value is itself trivially empty is a feature-off struct —
// e.g. the empty VpcConfig ({Ipv6AllowedForDualStack:false, SecurityGroupIds:[],
// SubnetIds:[]}) that Lambda materializes after a Cloud Control UpdateResource,
// which otherwise phantom-drifts on every revert (R46). Arrays stay length-0-only
// (no element recursion — [false] may be a meaningful list), same conservative
// stance as the top-level scalars (0 stays meaningful, false does not).
export function isTrivialEmpty(v: unknown): boolean {
  if (v === false || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.values(v).every(isTrivialEmpty);
  return false;
}

// The AWS-managed (`aws:*`) tag ELEMENTS of a {Key,Value}[] tag list — the exact
// inverse of what `stripAwsTagsDeep` drops. AWS forbids an external write that
// removes or re-asserts an `aws:`-prefixed tag key ("aws: prefixed tag key names
// are not allowed for external use"), so a Tags REVERT must carry these forward
// untouched (the revert only ever changes the USER tags). Returns [] for a
// non-list / a list with no managed tags. Used by the revert plan's tag-op guard.
export function awsManagedTags(v: unknown): { Key: string }[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is { Key: string } =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as { Key?: unknown }).Key === 'string' &&
      (t as { Key: string }).Key.startsWith('aws:')
  );
}

// A2: AWS-managed (aws:*) tags only. Handles BOTH the {Key,Value}[] list shape
// (most types) AND the key->value map shape (e.g. AWS::SSM::Parameter.Tags).
export function isAllAwsTags(v: unknown): boolean {
  if (Array.isArray(v)) {
    return (
      v.length > 0 &&
      v.every(
        (t) =>
          t &&
          typeof t === 'object' &&
          typeof (t as { Key?: unknown }).Key === 'string' &&
          (t as { Key: string }).Key.startsWith('aws:')
      )
    );
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => k.startsWith('aws:'));
  }
  return false;
}

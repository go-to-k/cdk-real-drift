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
  // An App Runner service that declares neither HealthCheckConfiguration nor
  // NetworkConfiguration reads both back fully materialized with AWS's constant
  // first-run defaults — a TCP health check and a public IPV4 DEFAULT-egress network.
  // Equality-gated (subset-tolerant), so a user who declares any of these knobs pushes
  // the property out of the undeclared tier, and an out-of-band change to any sub-field
  // (e.g. IsPubliclyAccessible=false, Interval=10) no longer matches and re-surfaces.
  // Observed live on a fresh RUNNING service (apprunner-service-rich, 2026-07-07).
  'AWS::AppRunner::Service': {
    HealthCheckConfiguration: {
      Protocol: 'TCP',
      Path: '/',
      Interval: 5,
      Timeout: 2,
      HealthyThreshold: 1,
      UnhealthyThreshold: 5,
    },
    NetworkConfiguration: {
      IpAddressType: 'IPV4',
      EgressConfiguration: { EgressType: 'DEFAULT' },
      IngressConfiguration: { IsPubliclyAccessible: true },
    },
  },
  // A Managed Service for Apache Flink application that declares no ApplicationMode
  // reads back STREAMING — the constant service default for Flink runtimes (the only
  // other value, INTERACTIVE, requires a Zeppelin/Studio runtime, a different declared
  // config; ApplicationMode is createOnly so it cannot drift). Equality-gated. Observed
  // live on a fresh READY Flink app (streaming-rich fixture, 2026-07-03; #509).
  'AWS::KinesisAnalyticsV2::Application': { ApplicationMode: 'STREAMING' },
  // An EventBridge API destination that declares no InvocationRateLimitPerSecond reads
  // back AWS's constant default of 300 requests/second (the documented default + maximum
  // when the property is omitted). Equality-gated: a user who sets a throttle (e.g. 10)
  // or an out-of-band console change no longer matches 300 and re-surfaces as real
  // undeclared drift. Observed live on a fresh events-apidest-rich ApiDestination
  // (2026-07-08).
  'AWS::Events::ApiDestination': { InvocationRateLimitPerSecond: 300 },
  // An Elastic Beanstalk Application that declares no ResourceLifecycleConfig reads back
  // the constant service default: a version-lifecycle policy carrying both rules present
  // but DISABLED (Enabled:false, MaxCount 200 / MaxAgeInDays 180, DeleteSourceFromS3:false).
  // Equality-gated: enable a lifecycle rule out of band and the object no longer matches,
  // so it re-surfaces as real undeclared drift. Observed live on a fresh elasticbeanstalk-
  // rich Application (2026-07-07).
  'AWS::ElasticBeanstalk::Application': {
    ResourceLifecycleConfig: {
      VersionLifecycleConfig: {
        MaxCountRule: { DeleteSourceFromS3: false, Enabled: false, MaxCount: 200 },
        MaxAgeRule: { DeleteSourceFromS3: false, MaxAgeInDays: 180, Enabled: false },
      },
    },
  },
  // An Elastic Beanstalk Environment that declares no Tier reads back the constant default
  // WebServer/Standard/1.0 tier. Equality-gated: a Worker-tier environment
  // ({Name:"Worker",Type:"SQS/HTTP"}) no longer matches, so it surfaces. Observed live on
  // a fresh elasticbeanstalk-rich Environment (2026-07-07).
  'AWS::ElasticBeanstalk::Environment': {
    Tier: { Type: 'Standard', Version: '1.0', Name: 'WebServer' },
  },
  // A classic ElasticLoadBalancing::LoadBalancer (CLB) that declares neither
  // ConnectionSettings nor ConnectionDrainingPolicy reads both back fully materialized
  // with AWS's constant first-run defaults: a 60-second idle timeout, and connection
  // draining DISABLED with a 300-second timeout. Neither is user intent — the template
  // never declared them. Equality-gated: raise the idle timeout out of band, or enable
  // draining, and the object no longer matches so it re-surfaces as real undeclared drift.
  // Observed live on a fresh internal CLB (elb-classic-rich, 2026-07-07).
  'AWS::ElasticLoadBalancing::LoadBalancer': {
    ConnectionSettings: { IdleTimeout: 60 },
    ConnectionDrainingPolicy: { Enabled: false, Timeout: 300 },
  },
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
  // S3 Express directory buckets are always encrypted; a never-declared bucket
  // reads back SSE-S3 with the bucket key ON (unlike general-purpose buckets,
  // which read BucketKeyEnabled:false and a BlockedEncryptionTypes field).
  // Observed live on a fresh s3express-s3tables-rich deploy.
  'AWS::S3Express::DirectoryBucket': {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        },
      ],
    },
  },
  // S3 Tables table buckets materialize three constant service defaults on read:
  // Standard storage class, table-level metrics off, and SSE-S3 encryption.
  // Observed live on a fresh s3express-s3tables-rich deploy; equality-gated like
  // every KNOWN_DEFAULTS entry, so moving any of them off the default (e.g. KMS
  // encryption set out of band) re-surfaces as real undeclared drift.
  'AWS::S3Tables::TableBucket': {
    StorageClassConfiguration: { StorageClass: 'STANDARD' },
    MetricsConfiguration: { Status: 'Disabled' },
    EncryptionConfiguration: { SSEAlgorithm: 'AES256' },
  },
  // Vended-logs v2 (CloudWatch Logs Delivery family). DeliveryDestinationType is
  // DERIVED from the declared DestinationResourceArn (a log-group destination always
  // reads back "CWL") — observed-only like the ApiGateway Authorizer AuthType fold; an
  // S3/FH/XRay destination's value simply doesn't match and surfaces once, recordable.
  'AWS::Logs::DeliveryDestination': { DeliveryDestinationType: 'CWL' },
  // A Delivery that declares no RecordFields materializes the source's FULL default
  // field list on read. This is the CloudFront ACCESS_LOGS default (the most common
  // vended source) — equality-gated, so a field added/removed/reordered out of band no
  // longer matches and surfaces as real undeclared drift; other sources' lists simply
  // don't fold. Observed live on a fresh cloudfront-kvs-logs-delivery deploy.
  'AWS::Logs::Delivery': {
    RecordFields: [
      'date',
      'time',
      'x-edge-location',
      'sc-bytes',
      'c-ip',
      'cs-method',
      'cs(Host)',
      'cs-uri-stem',
      'sc-status',
      'cs(Referer)',
      'cs(User-Agent)',
      'cs-uri-query',
      'cs(Cookie)',
      'x-edge-result-type',
      'x-edge-request-id',
      'x-host-header',
      'cs-protocol',
      'cs-bytes',
      'time-taken',
      'x-forwarded-for',
      'ssl-protocol',
      'ssl-cipher',
      'x-edge-response-result-type',
      'cs-protocol-version',
      'fle-status',
      'fle-encrypted-fields',
      'c-port',
      'time-to-first-byte',
      'x-edge-detailed-result-type',
      'sc-content-type',
      'sc-content-len',
      'sc-range-start',
      'sc-range-end',
    ],
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
  // A stream / self-managed-Kafka event source mapping created without these reads
  // them back as -1 (the documented "infinite" default: retry forever / no record-age
  // cap). A never-declared ESM otherwise reports both on every first run. Equality-gated
  // — set either to a finite value out of band and it no longer matches, so it
  // re-surfaces as real undeclared drift. (SQS event sources don't carry these props at
  // all, so the entry can't mis-fold there.) Observed live on a fresh esm-sourceaccess-rich
  // deploy.
  // Enabled: an ESM (e.g. CDK's SqsEventSource) is created enabled; the construct omits
  // Enabled when it leaves the default true, so the live read reports an undeclared
  // Enabled=true on every first run — observed live on a dev LineLink stack with no
  // out-of-band edit. (The off state Enabled=false is dropped upstream as trivially-empty
  // before this fold, mirroring the KMS Key Enabled case.) Merged into the single
  // EventSourceMapping entry — a duplicate object-literal key silently drops the earlier
  // retry/age fold (JS last-key-wins; #438 regressed it).
  'AWS::Lambda::EventSourceMapping': {
    MaximumRetryAttempts: -1,
    MaximumRecordAgeInSeconds: -1,
    Enabled: true,
    // A mapping that declares no batching window reads back MaximumBatchingWindowInSeconds: 0
    // (the documented "no window" default) — the CDK SqsEventSource omits it unless set.
    // Equality-gated: a mapping that pins a real window no longer matches and surfaces.
    // Observed live on a dev SQS-triggered function.
    MaximumBatchingWindowInSeconds: 0,
  },
  // An alias created without a Description reads back the empty string. Folded as
  // atDefault so a never-declared alias does not report `Description=""` as drift; it
  // is also the value REVERT_SET_DEFAULT_PATHS writes to undo an out-of-band Description
  // (UpdateAlias ignores an OMITTED description, so a bare `remove` is a silent no-op —
  // the alias must be sent Description:"" explicitly; proven live).
  'AWS::Lambda::Alias': { Description: '' },
  // A published version inherits the function's runtime-management config; a version
  // that pins nothing reads back the Auto default (observed live across every
  // `currentVersion` in a multi-function stack). The twin of the AWS::Lambda::Function
  // RuntimeManagementConfig default above; pin a version to a specific runtime and the
  // object no longer matches (equality-gated). The version's CodeSha256 is a per-deploy
  // content hash (not a constant default) — folded as `generated` via
  // GENERATED_TOPLEVEL_PATHS instead.
  'AWS::Lambda::Version': { RuntimePolicy: { UpdateRuntimeOn: 'Auto' } },
  'AWS::Events::Rule': { EventBusName: 'default' },
  'AWS::Athena::WorkGroup': {
    State: 'ENABLED',
    // A workgroup that declares ONLY Name/Description reads back AWS's whole default
    // WorkGroupConfiguration (the existing WorkGroupConfiguration.* nested paths only fire
    // when the object is PARTIALLY declared and thus descended; a fully-undeclared object is
    // reported whole, so it needs this top-level fold). EngineVersion's read-only
    // EffectiveEngineVersion is schema-stripped, leaving SelectedEngineVersion:AUTO. Observed
    // live (hunt 2026-07-03 round E). Equality-gated: any enforced non-default surfaces.
    WorkGroupConfiguration: {
      EnforceWorkGroupConfiguration: true,
      EngineVersion: { SelectedEngineVersion: 'AUTO' },
      PublishCloudWatchMetricsEnabled: true,
      RequesterPaysEnabled: false,
    },
  },
  // A fresh EKS cluster reads back several whole-object service defaults the template never
  // declares. Constants (equality-gated) — an out-of-band change to any surfaces. The
  // per-deploy-variable bits (KubernetesNetworkConfig.ServiceIpv4Cidr is 10.100 OR 172.20,
  // Version tracks the service default) are deliberately NOT folded — they stay record-worthy.
  // Observed live (hunt 2026-07-03 round E).
  'AWS::EKS::Cluster': {
    ControlPlaneScalingConfig: { Tier: 'standard' },
    UpgradePolicy: { SupportType: 'EXTENDED' },
  },
  // A vpc-cni (and other) addon reads back the kube-system namespace it installs into when
  // the template declares no NamespaceConfig. AddonVersion is per-cluster-version → record-worthy.
  'AWS::EKS::Addon': { NamespaceConfig: { Namespace: 'kube-system' } },
  // A WebACL that declares no on-source DDoS protection reads back AWS's default
  // OnSourceDDoSProtectionConfig — ALBLowReputationMode=ACTIVE_UNDER_DDOS (the first
  // enum value / documented default), so the live read reports it as undeclared
  // first-run noise on every WebACL. Equality-gated; a user that sets ALWAYS_ON still
  // surfaces. Observed live on a fresh wafv2-webacl-customkeys deploy (issue #440).
  'AWS::WAFv2::WebACL': {
    OnSourceDDoSProtectionConfig: { ALBLowReputationMode: 'ACTIVE_UNDER_DDOS' },
  },
  // A VPC Lattice service network created without a SharingConfig reads back the
  // service default `{enabled: true}` (RAM sharing allowed — note the service model's
  // lowercase sub-key), so every fresh service network reports it as undeclared
  // first-run noise. Equality-gated; a network with sharing disabled out of band
  // ({enabled: false}) still surfaces. Observed live on a fresh vpclattice-listener
  // deploy (issue #483).
  'AWS::VpcLattice::ServiceNetwork': { SharingConfig: { enabled: true } },
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
  // An ApplicationSignals ServiceLevelObjective that omits `Goal` reads it back
  // fully materialized with AWS's constant default: a rolling 7-day interval,
  // AttainmentGoal 99, WarningThreshold 50 (the schema documents "a rolling
  // interval of 7 days" / "99 is used" but does NOT annotate a `default`, so the
  // schema-driven fold can't reach it). Equality-gated whole-object, so a user who
  // declares Goal is compared in the declared loop, and any out-of-band change to a
  // sub-field (a different AttainmentGoal, a calendar interval) no longer matches
  // and re-surfaces. Observed live on a fresh period-based SLO (slo-notif-rich).
  'AWS::ApplicationSignals::ServiceLevelObjective': {
    Goal: {
      WarningThreshold: 50,
      AttainmentGoal: 99,
      Interval: { RollingInterval: { DurationUnit: 'DAY', Duration: 7 } },
    },
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
  'AWS::ElasticLoadBalancingV2::Listener': {
    // A listener that declares no mutual-TLS config reads back the "off" default.
    // Observed live on an HTTPS listener.
    MutualAuthentication: { Mode: 'off' },
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
  // NOTE: AWS::ApiGateway::Authorizer.AuthType is NOT a KNOWN_DEFAULTS entry — it is
  // folded value-independently via VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS below
  // (AuthType is a derived, non-declarable read-back of the declared Type).
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
    // A WebSocket (and HTTP) API that declares no ApiKeySelectionExpression reads back the
    // documented service default `$request.header.x-api-key`. Equality-gated so a declared /
    // other selection expression still surfaces — this type covers HTTP APIs too, but the
    // gate means only an UNDECLARED value exactly equal to this constant folds; any custom
    // value (or an out-of-band change) no longer matches and re-surfaces as real undeclared
    // drift. WebSocket API, live-proven 2026-07-08 #664.
    ApiKeySelectionExpression: '$request.header.x-api-key',
  },
  'AWS::ApiGatewayV2::Integration': {
    ConnectionType: 'INTERNET',
    // TimeoutInMillis is NOT a single constant on this shared type — its undeclared default is
    // protocol-specific: a WebSocket-API integration reads back 29000, an HTTP-API one reads
    // 30000 (per the CFn schema description). Both are stable constants, so both fold as tier-1
    // equality-gated defaults — but a single KNOWN_DEFAULTS key holds only one value, so the
    // pair lives in KNOWN_DEFAULT_ONE_OF below (a live value equal to EITHER folds; any other
    // value, or a declared timeout, still surfaces). See that entry for the full reasoning.
    // WebSocket integration constant service defaults, materialized on every route created
    // with CDK's WebSocketLambdaIntegration when the template declares none of them. All are
    // equality-gated so a declared / out-of-band-changed value still surfaces. This type ALSO
    // covers HTTP-API integrations, but the gate makes the fold HTTP-safe:
    //   - PayloadFormatVersion "1.0" — HTTP-API CDK L2 ALWAYS declares "2.0" (a declared value
    //     is never folded), and HTTP_PROXY declares "1.0" explicitly (also declared), so an
    //     equality-gated "1.0" fold can only match an UNDECLARED WebSocket integration.
    //   - IntegrationMethod "POST" — the AWS_PROXY default method for both protocols; a custom
    //     declared method (e.g. HTTP_PROXY "ANY") is compared in the declared dimension.
    //   - PassthroughBehavior "WHEN_NO_MATCH" — the documented default; any other value surfaces.
    // WebSocket API, live-proven 2026-07-08 #664.
    PayloadFormatVersion: '1.0',
    IntegrationMethod: 'POST',
    PassthroughBehavior: 'WHEN_NO_MATCH',
  },
  'AWS::CodeBuild::Project': {
    TimeoutInMinutes: 60,
    QueuedTimeoutInMinutes: 480,
    Visibility: 'PRIVATE', // the default; folds to atDefault so a never-declared project is not first-run noise — flipping to PUBLIC_READ no longer matches and surfaces
    Cache: { Type: 'NO_CACHE' }, // BatchGetProjects always returns cache; the unconfigured default folds to atDefault so a never-declared cache is not first-run noise — switching to S3/LOCAL no longer matches and surfaces
  },
  // A PAY_PER_REQUEST (on-demand) DynamoDB table reads back a baseline WarmThroughput
  // that AWS assigns to every fresh table (12000 read / 4000 write units) even though the
  // template never declares it — observed live on a dev LineLink stack (GlobalTable /
  // TableV2) and a dev reco-MailQueues stack (classic AWS::DynamoDB::Table), neither with
  // an out-of-band edit. The service default is identical for both CFn types, so both fold.
  // Equality-gated: a table that has WARMED UP to a higher value under traffic no longer
  // matches and surfaces as a real undeclared value (the warm throughput auto-ratchets and
  // never decreases), and an explicitly declared WarmThroughput compares as declared
  // instead. Top-level WarmThroughput only — the GSI-nested `*.WarmThroughput` stays
  // surfaced (see KNOWN_DEFAULT_PATHS note below).
  'AWS::DynamoDB::Table': {
    BillingMode: 'PROVISIONED',
    DeletionProtectionEnabled: false,
    WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
  },
  'AWS::DynamoDB::GlobalTable': {
    WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
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
    // AWS auto-assigns Standard when Tier is not declared (the SDK_SUPPLEMENTS reader
    // projects it); folds an undeclared Standard so it is not noise. A real Advanced /
    // Intelligent-Tiering value still surfaces (undeclared) or compares (declared).
    Tier: 'Standard',
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
    // A pool that declares NO Policies reads back Cognito's constant default password
    // policy (min length 8, all four character classes required, 7-day temp-password
    // lifetime) plus the SignInPolicy default (PASSWORD as the sole first factor). The
    // whole object is live-only on such a pool, so the KNOWN_DEFAULT_PATHS sub-entries
    // (which fold only when a PARTIAL Policies is declared) never reach it — fold the
    // full default object here. Equality-gated (subset-tolerant): a pool that pins any
    // non-default policy value no longer matches and surfaces. Observed live.
    Policies: {
      PasswordPolicy: {
        MinimumLength: 8,
        RequireLowercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
        RequireUppercase: true,
        TemporaryPasswordValidityDays: 7,
      },
      SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
    },
    // A pool that declares no custom KMS key reads back the AWS-owned-key default, and a
    // pool that does not customize its token issuer reads back Type "ORIGINAL" — both
    // Cognito-materialized constants the template never carries. Equality-gated: a pool
    // that wires its own CMK (KeyType != AWS_OWNED_KEY) or a non-original issuer no
    // longer matches and surfaces. Observed live.
    KeyConfiguration: { KeyType: 'AWS_OWNED_KEY' },
    IssuerConfiguration: { Type: 'ORIGINAL' },
  },
  // An identity pool that declares no allowClassicFlow reads back AllowClassicFlow=false
  // (the documented default). Equality-gated: switch it on out of band and the value no
  // longer matches, so it re-surfaces as real undeclared drift (and reverts to false via
  // REVERT_SET_DEFAULT_PATHS — a bare `remove` is a no-op because UpdateIdentityPool
  // leaves an omitted AllowClassicFlow unchanged).
  'AWS::Cognito::IdentityPool': {
    AllowClassicFlow: false,
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
    EnableExecuteCommand: false,
    // A service that declares no deployment controller reads back the default rolling
    // (ECS) controller. Observed live on a fresh Fargate service.
    DeploymentController: { Type: 'ECS' },
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
  'AWS::IAM::User': {
    Path: '/',
  },
  'AWS::IAM::InstanceProfile': {
    Path: '/',
  },
  // A fresh ECS Cluster reads back `ClusterSettings: [{Name:'containerInsights',Value:'disabled'}]`
  // — Container Insights defaults to disabled unless the account-level ECS setting turns it on, and
  // CDK does not declare it unless `containerInsights` is passed. Equality-gated (an enabled cluster
  // reports a different Value and re-surfaces). CapacityProviders / DefaultCapacityProviderStrategy
  // are NOT defaults — they are declared by the sibling ClusterCapacityProviderAssociations resource
  // and dropped in classify (see hasSiblingCapacityProviders).
  'AWS::ECS::Cluster': {
    ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
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
    // The documented EC2 default: a standard ENI has source/destination checking on. A NAT
    // instance / router explicitly declares SourceDestCheck:false, which still surfaces
    // (equality-gated). Observed live (hunt 2026-07-03 round F).
    SourceDestCheck: true,
  },
  // A collection that declares no DeletionProtection reads back AWS's DISABLED default.
  // A user who enables it declares "ENABLED", which still surfaces (equality-gated).
  // Observed live (hunt 2026-07-03 round F).
  'AWS::OpenSearchServerless::Collection': { DeletionProtection: 'DISABLED' },
  // A SAML provider that declares no AssertionEncryptionMode reads back AWS's "Allowed"
  // default. A user who requires encryption declares "Required", which still surfaces
  // (equality-gated). Observed live (hunt 2026-07-03 round F).
  'AWS::IAM::SAMLProvider': { AssertionEncryptionMode: 'Allowed' },
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
    // EngineLifecycleSupport is NOT a constant default. Its value is set by the resource's
    // ORIGINAL creation era (a pre-RDS-Extended-Support lineage reads `-disabled`, a newer one
    // the `-extended-support` default), but a RESTORE resets the readable `ClusterCreateTime`
    // to the restore date — so an untouched, undeclared cluster can read `-disabled` under a
    // recent timestamp, and the live model exposes no signal that reconstructs it. Folded
    // value-independent via VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS (see the full note there);
    // a DECLARED value is compared in the declared loop (detected).
    MonitoringInterval: 0,
    NetworkType: 'IPV4',
    StorageThroughput: 0,
    // Boolean feature flags off by default (observed unanimous across the corpus
    // instances). Engine-DERIVED values (Port, LicenseModel, StorageType, AllocatedStorage)
    // fold via ENGINE_DEFAULTS, and the default parameter/option groups via
    // DEFAULT_MANAGED_NAME_PATHS; still NOT folded here: genuinely per-resource values
    // (EngineVersion, MasterUsername).
    CopyTagsToSnapshot: false,
    DedicatedLogVolume: false,
    EnableIAMDatabaseAuthentication: false,
    EnablePerformanceInsights: false,
    ManageMasterUserPassword: false,
    MultiAZ: false,
    StorageEncrypted: false,
    // The current AWS default RDS server certificate authority — unanimous across every
    // corpus DBInstance (aurora-mysql AND mysql) and both real Aurora dogfood stacks. A
    // constant, not engine-derived. Equality-gated: AWS rotates the default CA over time, so
    // a differing identifier (an older CA, or one the user pinned) still surfaces.
    CACertificateIdentifier: 'rds-ca-rsa2048-g1',
  },
  'AWS::RDS::DBCluster': {
    AutoMinorVersionUpgrade: true,
    DatabaseInsightsMode: 'standard',
    // EngineLifecycleSupport folds value-independent (see the DBInstance note above) — a
    // pre-Extended-Support lineage reads `-disabled` and a restore hides the original creation
    // era behind the restore-date ClusterCreateTime, so it is not a constant KNOWN_DEFAULTS value.
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
    // AWS-materialized defaults a domain reads back on every first run (found by the offline
    // noise sweep, unanimous across the corpus domains): the automated-snapshot hour AWS assigns
    // (0 = midnight UTC) and the two default AdvancedOptions the service always returns. Equality-
    // gated: a domain that sets a non-default snapshot hour / advanced option no longer matches
    // and surfaces. (OffPeakWindowOptions — an AWS-ASSIGNED window object — folds value-
    // independent below, not here, since its start time is AWS's per-domain choice, not a constant.)
    SnapshotOptions: { AutomatedSnapshotStartHour: 0 },
    AdvancedOptions: {
      override_main_response_version: 'false',
      'rest.action.multi.allow_explicit_index': 'true',
    },
    // A domain that declares no deployment strategy reads back the AWS default
    // "CapacityOptimized" (live-verified on a fresh opensearch-rich deploy, undeclared).
    // Equality-gated: a different strategy surfaces. (EncryptionAtRestOptions.KmsKeyId — the
    // AWS-assigned encryption key — folds value-independent via GENERATED_NESTED_PATHS below.)
    DeploymentStrategyOptions: { DeploymentStrategy: 'CapacityOptimized' },
  },
  // A Redshift cluster reads back a raft of AWS-assigned constant defaults the template never
  // declares (found by the offline noise sweep, live-verified on a fresh redshift-rich RA3
  // single-node deploy — the clean-deploy=zero-potential-drift invariant). Equality-gated: any
  // value moved off the default surfaces. `NumberOfNodes` folds at 1 (the single-node default; a
  // resize to a multi-node cluster surfaces). `Encrypted` and `AvailabilityZoneRelocationStatus`
  // are NodeType-DERIVED (RA3 is always encrypted + AWS enables AZ relocation) so they fold via a
  // classify conditional keyed on the declared NodeType, not here. `ClusterVersion` is the AWS-
  // assigned engine version → value-independent below; `AvailabilityZone` likewise.
  'AWS::Redshift::Cluster': {
    Port: 5439,
    AutomatedSnapshotRetentionPeriod: 1,
    ManualSnapshotRetentionPeriod: -1,
    AllowVersionUpgrade: true,
    AquaConfigurationStatus: 'auto',
    MaintenanceTrackName: 'current',
    KmsKeyId: 'AWS_OWNED_KMS_KEY',
    NumberOfNodes: 1,
  },
  'AWS::EC2::VPCEndpoint': {
    IpAddressType: 'ipv4',
    // An endpoint that declares no `PolicyDocument` reads back the AWS-attached DEFAULT policy:
    // full access ("allow every principal every action on every resource"). It is the standard
    // default, not user intent — a user who tightens access DECLARES a policy, which no longer
    // matches this default and surfaces WHOLE (equality-gated, so out-of-band tightening is
    // still detected). Observed live on a fresh S3 gateway endpoint (vpc-common). Stored in the
    // canonical shape the compare pipeline (normalizePoliciesDeep) produces for the live value.
    PolicyDocument: {
      Version: '2008-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['*'], Resource: ['*'] }],
    },
    // (DnsOptions is AWS-service-assigned whole and folds value-independent — its default varies
    // by endpoint type, so it cannot be one equality-gated constant. See
    // VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS below.)
  },
  // An Elastic IP that brings no BYOIP pool reads back the standard Amazon-provided pool
  // ("amazon"). Create-only and the constant default, not user intent — a BYOIP address
  // DECLARES its own PublicIpv4Pool, which no longer matches and surfaces. Equality-gated.
  // Observed live on a fresh EIP (vpc-common NAT gateway).
  'AWS::EC2::EIP': {
    PublicIpv4Pool: 'amazon',
  },
  'AWS::EC2::TransitGateway': {
    SecurityGroupReferencingSupport: 'disable',
  },
  'AWS::EC2::FlowLog': {
    MaxAggregationInterval: 600,
  },
  // EC2 echoes SpreadLevel "rack" even on partition-strategy groups (where the
  // property is inapplicable); "rack" is also the documented default for spread.
  'AWS::EC2::PlacementGroup': {
    SpreadLevel: 'rack',
  },
  // IPAM defaults metering to the IPAM owner's account.
  'AWS::EC2::IPAM': {
    MeteredAccount: 'ipam-owner',
  },
  // A Client VPN endpoint that declares neither VpnPort nor DisconnectOnSessionTimeout
  // reads back the constant service defaults (port 443, disconnect-on-timeout on).
  // Observed live on a fresh ClientVPN deploy (us-east-1, 2026-07-03; #554 from #534's
  // live verify). Equality-gated: flip either out of band (e.g. VpnPort=1194) and the
  // value no longer matches, so it re-surfaces as real undeclared drift.
  'AWS::EC2::ClientVpnEndpoint': {
    VpnPort: 443,
    DisconnectOnSessionTimeout: true,
  },
  // A DAX cluster that declares no ClusterEndpointEncryptionType reads back "NONE" (the
  // constant service default; the only other value, "TLS", is an explicit opt-in).
  // Observed live on a fresh DAX deploy (us-east-1, 2026-07-03; #554). Equality-gated.
  // (PreferredMaintenanceWindow / SecurityGroupIds and the ParameterGroup's parameter
  // values are per-resource/AWS-assigned, so they are deliberately NOT folded here.)
  'AWS::DAX::Cluster': {
    ClusterEndpointEncryptionType: 'NONE',
  },
  // Managed Prometheus materializes a WorkspaceConfiguration of service defaults
  // (150-day retention, 60s rule-query offset / out-of-order window) on every
  // workspace that never declared one.
  'AWS::APS::Workspace': {
    WorkspaceConfiguration: {
      RuleQueryOffsetInSeconds: 60,
      RetentionPeriodInDays: 150,
      OutOfOrderTimeWindowInSeconds: 60,
      LimitsPerLabelSets: [],
    },
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
  // A warm pool that declares no MinSize reads back MinSize:0 — the documented
  // constant default ("minimum 0 warmed instances"). Observed undeclared on a fresh
  // ecs-capacityprovider-rich deploy. Equality-gated: raise it out of band and it
  // no longer matches, so it surfaces as real undeclared drift.
  'AWS::AutoScaling::WarmPool': {
    MinSize: 0,
  },
  'AWS::DocDB::DBCluster': {
    Port: 27017, // DocDB's fixed default port
    // DocumentDB's documented default backup retention (1 day) — surfaced as undeclared
    // first-run noise whenever a template omits it. Equality-gated: a longer retention the
    // user sets (or later changes out of band) is not 1, so it still surfaces.
    BackupRetentionPeriod: 1,
  },
  'AWS::DocDB::DBInstance': {
    // The current AWS default server certificate authority a DocDB instance reads back on a
    // fresh deploy — the same constant CA folded for RDS::DBInstance above. Equality-gated:
    // AWS rotates the default CA over time, so an older/pinned identifier still surfaces.
    CACertificateIdentifier: 'rds-ca-rsa2048-g1',
  },
  'AWS::EC2::VolumeAttachment': {
    // A standard single-card EBS attachment always reports card index 0; a nonzero index
    // (a multi-card Nitro instance) is meaningful and still surfaces under the equality gate.
    EbsCardIndex: 0,
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
  // FIS experiment templates read back the documented option defaults (fail on
  // empty target resolution, single-account targeting) when the template declares
  // no ExperimentOptions. Observed live on the misc-0cov-rich fixture.
  // Equality-gated: multi-account targeting or skip-mode no longer matches.
  'AWS::FIS::ExperimentTemplate': {
    ExperimentOptions: {
      EmptyTargetResolutionMode: 'fail',
      AccountTargeting: 'single-account',
    },
  },
  // A Verified Permissions policy store is created without deletion protection by
  // default. Observed live on the misc-0cov-rich fixture. Equality-gated: enabling
  // protection out of band no longer matches and surfaces.
  // Schema: a store created without a Cedar schema reads back the constant empty-schema
  // husk `{"CedarJson":"{}"}` (an empty Cedar schema serialized as the string "{}" inside
  // an object) — a JSON-string cousin of the #491 Workgroup husk, but the non-empty "{}"
  // string defeats the trivially-empty drop, so it needs an explicit equality-gated
  // default. A store that later declares a real Cedar schema reads a non-matching value
  // and surfaces (undeclared). Observed live on hunt round B (#496 note 2 — a top-level
  // undeclared key, so KNOWN_DEFAULTS not KNOWN_DEFAULT_PATHS is the fit).
  'AWS::VerifiedPermissions::PolicyStore': {
    DeletionProtection: { Mode: 'DISABLED' },
    Schema: { CedarJson: '{}' },
  },
  // RedshiftServerless service defaults (observed live on hunt 2026-07-03, #492): a
  // namespace reads back the "admin" default admin username and the AWS-owned KMS key
  // sentinel; a workgroup reads back the Redshift default Port, the "current" release
  // track, and price-performance auto-scaling DISABLED. All equality-gated — a namespace
  // that sets its own admin/KMS, or a workgroup on a pinned track / non-default port, no
  // longer matches and surfaces. The Workgroup echo attribute (a full self-echo of the
  // model) is handled separately (see the ECHO_HUSK_DEFAULTS note / #491).
  'AWS::RedshiftServerless::Namespace': {
    AdminUsername: 'admin',
    KmsKeyId: 'AWS_OWNED_KMS_KEY',
  },
  'AWS::RedshiftServerless::Workgroup': {
    Port: 5439,
    TrackName: 'current',
    PricePerformanceTarget: { Status: 'DISABLED' },
    // The Workgroup echo attribute is a full self-echo of the model; the schema marks only
    // its LEAVES readOnly (WorkgroupId, NetworkInterfaceId, ...), so a strip residue "husk"
    // survives: `{Endpoint:{VpcEndpoints:[{NetworkInterfaces:[{},{}]}]}, PricePerformanceTarget:
    // {Status:"DISABLED"}}` (#491). matchesKnownDefault skips the trivially-empty `Endpoint`
    // (the extended isTrivialEmpty folds the `[{},{}]` ENI husk regardless of per-deploy ENI
    // count), so only the meaningful `PricePerformanceTarget` sub-key is matched here — a
    // workgroup with price-performance ENABLED reads a non-matching value and surfaces.
    Workgroup: { PricePerformanceTarget: { Status: 'DISABLED' } },
  },
  // Bedrock Agent service defaults (observed live on hunt 2026-07-03, #492): an agent
  // reads back multi-agent collaboration DISABLED and the DEFAULT orchestration type when
  // the template declares neither. Equality-gated — an agent that opts into collaboration
  // or a custom orchestration no longer matches and surfaces. (AgentAlias
  // RoutingConfiguration is per-resource state, NOT a default — deliberately not folded.)
  'AWS::Bedrock::Agent': {
    AgentCollaboration: 'DISABLED',
    OrchestrationType: 'DEFAULT',
    // An agent that declares no idle-session TTL reads back AWS's 600-second default
    // (observed live, hunt 2026-07-08, #619). A user-settable knob — equality-gated, so an
    // agent that raises/lowers it surfaces as real undeclared drift. (Live: an out-of-band
    // 600->1200 re-surfaced correctly after record.)
    IdleSessionTTLInSeconds: 600,
  },
  // A Site-to-Site VPN gateway that declares no ASN reads back AWS's 64512 default private
  // ASN (observed live, hunt 2026-07-08, #619). createOnly, so it never drifts; equality-
  // gated all the same (a gateway created with a custom ASN declares it, compared).
  'AWS::EC2::VPNGateway': {
    AmazonSideAsn: 64512,
  },
  // A CodeGuru Profiler group that declares no compute platform reads back the constant
  // "Default" (enum Default|AWSLambda; the CFn schema annotates no default). createOnly.
  // Equality-gated (an AWSLambda group is declared, compared). Live, hunt 2026-07-08 (#622).
  'AWS::CodeGuruProfiler::ProfilingGroup': {
    ComputePlatform: 'Default',
  },
  // A Service Catalog product that declares no product type reads back the constant
  // "CLOUD_FORMATION_TEMPLATE" AWS materializes (observed live, hunt 2026-07-08, #625).
  // Equality-gated, so a MARKETPLACE/EXTERNAL product (declared) still surfaces. The nested
  // per-artifact Type echo folds via KNOWN_DEFAULT_PATHS below.
  'AWS::ServiceCatalog::CloudFormationProduct': {
    ProductType: 'CLOUD_FORMATION_TEMPLATE',
  },
  // An Internet Monitor that declares no Status reads back "ACTIVE" (observed live, hunt
  // 2026-07-08 round F, #626). A user-settable knob (a user pausing a monitor sets INACTIVE)
  // — equality-gated, so a paused monitor surfaces as real undeclared drift.
  'AWS::InternetMonitor::Monitor': {
    Status: 'ACTIVE',
  },
  // A Roles Anywhere profile that declares neither a session duration nor attribute mappings
  // reads back AWS's 3600-second default and the constant default attribute-mapping set
  // (observed live, hunt 2026-07-08, #619). DurationSeconds is a user-settable knob (equality-
  // gated, a custom TTL surfaces); AttributeMappings is the whole-array constant AWS seeds
  // (same shape family as the TrustAnchor NotificationSettings whole-array default).
  'AWS::RolesAnywhere::Profile': {
    DurationSeconds: 3600,
    AttributeMappings: [
      { CertificateField: 'x509Issuer', MappingRules: [{ Specifier: '*' }] },
      {
        CertificateField: 'x509SAN',
        MappingRules: [{ Specifier: 'DNS' }, { Specifier: 'URI' }, { Specifier: 'Name/*' }],
      },
      { CertificateField: 'x509Subject', MappingRules: [{ Specifier: '*' }] },
    ],
  },
  // A Kinesis Video stream that declares no retention reads back 0 hours (retain nothing —
  // the create default). A signaling channel that declares neither Type nor MessageTtlSeconds
  // reads back SINGLE_MASTER / 60s. All constant, user-settable knobs — equality-gated, so a
  // channel created FULL_MESH or a stream with a retention window surfaces. Live, hunt
  // 2026-07-08 round E (#624). (StreamStorageConfiguration folds via the object descend; the
  // AWS-managed KmsKeyId via CONTEXT_ARN_DEFAULTS.)
  'AWS::KinesisVideo::Stream': {
    DataRetentionInHours: 0,
  },
  'AWS::KinesisVideo::SignalingChannel': {
    Type: 'SINGLE_MASTER',
    MessageTtlSeconds: 60,
  },
  // A CodeStar notification rule / Recycle Bin rule read back the "on" default status when
  // the template declares none (observed live on hunt 2026-07-03, #492). These ARE
  // user-settable knobs (a user can pause a rule) — equality-gated, so a DISABLED rule no
  // longer matches and surfaces as a real undeclared value.
  'AWS::CodeStarNotifications::NotificationRule': {
    Status: 'ENABLED',
  },
  'AWS::Rbin::Rule': {
    Status: 'available',
  },
  // RolesAnywhere service-filled constant SETS on create (observed live on hunt
  // 2026-07-03, #492): a trust anchor reads back the two-entry certificate-expiry
  // notification set, and a profile reads back the default x509 attribute-mapping rules,
  // when the template declares neither. Whole-value equality-gated — a trust anchor with
  // custom notifications, or a profile with custom mappings, no longer matches and surfaces.
  'AWS::RolesAnywhere::TrustAnchor': {
    NotificationSettings: [
      { Channel: 'ALL', Enabled: true, Event: 'CA_CERTIFICATE_EXPIRY', Threshold: 45 },
      { Channel: 'ALL', Enabled: true, Event: 'END_ENTITY_CERTIFICATE_EXPIRY', Threshold: 45 },
    ],
  },
  // Amazon Location deprecated `PricingPlan` parameter — the service echoes the constant
  // "RequestBasedUsage" on EVERY Location resource (tracker / geofence collection / place
  // index / map / route calculator) even though the parameter is deprecated and
  // un-settable (observed live on hunt 2026-07-03 #492, then on all five types
  // location-rich 2026-07-07). Equality-gated. Also folds each type's other constant
  // first-run defaults the template never declares: a Tracker with no PositionFiltering
  // reads back "TimeBased" (the service default; AccuracyBased/DistanceBased are the other
  // settable values, so a change re-surfaces), and a PlaceIndex with no
  // DataSourceConfiguration reads back {IntendedUse:"SingleUse"} (the default; "Storage"
  // is the other value). Both observed live on a fresh location-rich stack (2026-07-07).
  'AWS::Location::Tracker': {
    PricingPlan: 'RequestBasedUsage',
    PositionFiltering: 'TimeBased',
  },
  'AWS::Location::GeofenceCollection': {
    PricingPlan: 'RequestBasedUsage',
  },
  'AWS::Location::PlaceIndex': {
    PricingPlan: 'RequestBasedUsage',
    DataSourceConfiguration: { IntendedUse: 'SingleUse' },
  },
  'AWS::Location::Map': {
    PricingPlan: 'RequestBasedUsage',
  },
  'AWS::Location::RouteCalculator': {
    PricingPlan: 'RequestBasedUsage',
  },
  // hunt 2026-07-03 round B (#496): constant service defaults on zero-coverage type
  // families (MediaTailor / IVS / Lightsail / Site-to-Site VPN / Transfer / DataSync /
  // AppFlow / DataBrew). Values are exactly what Cloud Control returned on a fresh
  // untouched deploy; none is a per-resource id/ARN/name, so the equality-gated fold can
  // never hide a real change. Per-resource derived state is deliberately NOT folded (ELB
  // AvailabilityZones mirrors declared Subnets — #496 note 1).
  'AWS::MediaTailor::PlaybackConfiguration': {
    InsertionMode: 'STITCHED_ONLY',
    AdConditioningConfiguration: { StreamingMediaFileConditioning: 'TRANSCODE' },
    AvailSuppression: { Mode: 'OFF' },
  },
  'AWS::IVS::Channel': {
    MultitrackInputConfiguration: { Enabled: false, MaximumResolution: 'FULL_HD', Policy: 'ALLOW' },
  },
  'AWS::Lightsail::Instance': {
    KeyPairName: 'LightsailDefaultKeyPair',
  },
  'AWS::Lightsail::Disk': {
    AddOns: [{ AddOnType: 'AutoSnapshot', Status: 'Disabled' }],
  },
  'AWS::Lightsail::Bucket': {
    AccessRules: { AllowPublicOverrides: false, GetObject: 'private' },
  },
  'AWS::Lightsail::Alarm': {
    NotificationTriggers: ['ALARM'],
  },
  'AWS::EC2::VPNConnection': {
    RemoteIpv4NetworkCidr: '0.0.0.0/0',
    LocalIpv4NetworkCidr: '0.0.0.0/0',
    OutsideIpAddressType: 'PublicIpv4',
    TunnelInsideIpVersion: 'ipv4',
  },
  'AWS::Transfer::Server': {
    IpAddressType: 'IPV4',
    ProtocolDetails: {
      PassiveIp: 'AUTO',
      SetStatOption: 'DEFAULT',
      TlsSessionResumptionMode: 'ENFORCED',
    },
    // A server created without SecurityPolicyName is assigned AWS's stable default
    // policy (TransferSecurityPolicy-2018-11 — kept as the default-for-new-servers for
    // backward compatibility even as AWS ships newer named policies). Equality-gated so
    // a user picking a different policy (a meaningful security change) still surfaces.
    SecurityPolicyName: 'TransferSecurityPolicy-2018-11',
    // Domain is create-only and defaults to S3 when omitted; equality-gated so an
    // EFS-domain server that declared it is unaffected (it never reaches undeclared).
    Domain: 'S3',
    // S3StorageOptions defaults to directory-listing optimization DISABLED.
    S3StorageOptions: {
      DirectoryListingOptimization: 'DISABLED',
    },
  },
  'AWS::DataSync::Task': {
    TaskMode: 'BASIC',
  },
  // AppFlow FlowStatus is a user-settable knob (a user can suspend a flow), like the
  // CodeStarNotifications Status above — equality-gated so a suspended flow surfaces.
  'AWS::AppFlow::Flow': {
    FlowStatus: 'Active',
  },
  // DataBrew Dataset Source is a per-input-kind constant ("S3" for an S3 dataset); the
  // equality-gated fold is safe (a JDBC/Redshift dataset reads a non-matching value).
  'AWS::DataBrew::Dataset': {
    Source: 'S3',
  },
  // Amazon Keyspaces service defaults (observed live on the misc-0cov-rich
  // fixture): a keyspace with no ReplicationSpecification is single-region; a
  // table with no explicit settings reads back the account-constant warm
  // throughput floor (12000/4000 — same constant DynamoDB TableV2 reports), the
  // AWS-owned KMS key, and CDC disabled. All equality-gated.
  'AWS::Cassandra::Keyspace': {
    ReplicationSpecification: { ReplicationStrategy: 'SINGLE_REGION' },
  },
  'AWS::Cassandra::Table': {
    WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
    EncryptionSpecification: { EncryptionType: 'AWS_OWNED_KMS_KEY' },
    CdcSpecification: { Status: 'DISABLED' },
  },
  // EMR Serverless application service defaults (observed live on the
  // misc-0cov-rich fixture): x86_64 architecture and managed-persistence
  // monitoring enabled. Equality-gated: an ARM64 app or disabled managed
  // persistence no longer matches and surfaces.
  'AWS::EMRServerless::Application': {
    Architecture: 'X86_64',
    MonitoringConfiguration: {
      ManagedPersistenceMonitoringConfiguration: { Enabled: true },
    },
  },
  // Amplify app service defaults (observed live on the amplify-codeconnections-rich
  // fixture): the standard build compute size and the managed no-cookies CDN cache.
  // Equality-gated: a larger build machine or cookie-forwarding cache no longer
  // matches and surfaces.
  'AWS::Amplify::App': {
    JobConfig: { BuildComputeType: 'STANDARD_8GB' },
    CacheConfig: { Type: 'AMPLIFY_MANAGED_NO_COOKIES' },
  },
  // A hostless connection (GitHub/Bitbucket cloud providers) reads HostArn back as
  // this literal ALL-ZEROS placeholder ARN — a service sentinel for "no host", not
  // a reference to anything in the user's account (region/account/id are all
  // zeroed constants). Observed live on the amplify-codeconnections-rich fixture.
  // Equality-gated: a real GitHub Enterprise / GitLab self-managed host ARN no
  // longer matches and surfaces.
  'AWS::CodeStarConnections::Connection': {
    HostArn:
      'arn:aws:codestar-connections:us-west-2:000000000000:host/00000000-0000-0000-0000-000000000000',
  },
};

// A top-level twin of KNOWN_DEFAULTS for the rare property whose undeclared AWS default is a
// stable constant but takes ONE OF SEVERAL values depending on a sibling the value itself does
// not carry. Each entry lists the full SET of accepted defaults; a live value that deep-equals
// ANY member folds to `atDefault`, and anything else — including a declared value — still
// surfaces. This is still tier-1 (equality-gated constants), just against a small closed set
// rather than a single value; it is NOT a tier-2 derivation (no value is computed from the
// declared inputs). Reach for it ONLY when the two-plus defaults are genuine, stable constants
// and the discriminator (e.g. the parent's protocol) is off the resource's own model.
export const KNOWN_DEFAULT_ONE_OF: Record<string, Record<string, readonly unknown[]>> = {
  // AWS::ApiGatewayV2::Integration is shared by HTTP and WebSocket APIs, and its undeclared
  // TimeoutInMillis default is protocol-specific: a WebSocket integration reads back 29000, an
  // HTTP integration reads back 30000 (per the CFn schema description). Both are stable
  // constants, but the discriminator — the parent Api's ProtocolType — is not on the Integration
  // model, so a single KNOWN_DEFAULTS constant cannot cover both without breaking the other.
  // Folding the SET {29000, 30000} keeps a clean deploy of EITHER protocol at zero first-run
  // drift, while equality-gating preserves detection: a user who DECLARES a timeout is compared
  // in the declared dimension (never folded), and an out-of-band change to any value outside the
  // set (e.g. 10000) re-surfaces as real undeclared drift. HTTP's 30000 and WebSocket's 29000
  // are folded as PEERS here — neither masks the other, and neither masks a custom value.
  'AWS::ApiGatewayV2::Integration': {
    TimeoutInMillis: [29000, 30000],
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
// the parent Resource's id). Genuine resource-/account-specific inventory stays
// EXCLUDED from both (Budgets `Budget.BudgetName`, the GSI-nested
// `*.WarmThroughput`). The TOP-LEVEL TableV2 `WarmThroughput`, by contrast, IS a
// constant first-run default (12000/4000) and folds via KNOWN_DEFAULTS above —
// equality-gated, so a warmed-up table still surfaces.
export const KNOWN_DEFAULT_PATHS: Record<string, Record<string, unknown>> = {
  // A WebSocket API Stage whose DefaultRouteSettings declares only throttling (CDK's
  // WebSocketStage renders just ThrottlingRateLimit / ThrottlingBurstLimit) reads back the
  // sibling `LoggingLevel: "OFF"` — the documented service default AWS fills into
  // DefaultRouteSettings. Equality-gated so turning logging on out of band (INFO/ERROR) no
  // longer matches and re-surfaces as real undeclared drift. (The `DataTraceEnabled` /
  // `DetailedMetricsEnabled` false siblings fold via isTrivialEmpty and do not surface.)
  // WebSocket API, live-proven 2026-07-08 #664.
  'AWS::ApiGatewayV2::Stage': {
    'DefaultRouteSettings.LoggingLevel': 'OFF',
  },
  // A Service Catalog product's provisioning artifact that declares no Type reads back the
  // constant "CLOUD_FORMATION_TEMPLATE" (observed live, hunt 2026-07-08, #625) — the nested
  // twin of the top-level ProductType fold above. Equality-gated, so an artifact created as a
  // different type still surfaces.
  'AWS::ServiceCatalog::CloudFormationProduct': {
    'ProvisioningArtifactParameters.*.Type': 'CLOUD_FORMATION_TEMPLATE',
  },
  // A Managed Service for Apache Flink application that declares no encryption config
  // reads back the AWS-owned-key default. Constant (a customer CMK is set explicitly).
  // Equality-gated: an out-of-band switch to a customer key no longer matches. Observed
  // live on a fresh READY Flink app (streaming-rich fixture, 2026-07-03; #509).
  'AWS::KinesisAnalyticsV2::Application': {
    'ApplicationConfiguration.ApplicationEncryptionConfiguration': { KeyType: 'AWS_OWNED_KEY' },
  },
  'AWS::Lambda::Function': {
    // A function whose LoggingConfig declares no explicit format/level reads back the AWS
    // defaults: plain-Text logs at the INFO system level. Equality-gated, so a function that
    // opts into JSON logging (or a different level) still surfaces the non-default value.
    'LoggingConfig.LogFormat': 'Text',
    'LoggingConfig.SystemLogLevel': 'INFO',
    // A function that opts into JSON logs (`LogFormat: 'JSON'`, declared) but does not pin an
    // application log level reads back the AWS default INFO for the undeclared
    // `ApplicationLogLevel` sub-key — observed live on fresh (non-imported) stacks whose
    // functions set only LogFormat. Equality-gated, so a function that pins a different level
    // (DEBUG/ERROR/…) still surfaces the non-default value. (A Lambda DURABLE FUNCTION defaults
    // LogFormat itself to JSON — see the DurableConfig override in classify.ts.)
    'LoggingConfig.ApplicationLogLevel': 'INFO',
  },
  // EMR Serverless fills MaximumCapacity.Disk with the service-wide maximum
  // ("400000 GB") when the template declares only Cpu/Memory. A constant, not
  // capacity-derived (observed with a 4 vCPU / 16 GB cap on the misc-0cov-rich
  // fixture). Equality-gated: a real disk cap no longer matches and surfaces.
  'AWS::EMRServerless::Application': {
    'MaximumCapacity.Disk': '400000 GB',
  },
  // ECS materializes ManagedDraining:"ENABLED" (the documented constant default) into
  // AutoScalingGroupProvider when the template omits it — CDK's AsgCapacityProvider
  // doesn't render it unless set, so every ECS-on-EC2 first run reports it as
  // undeclared. Equality-gated: disable draining out of band and it surfaces.
  // Observed live on a fresh ecs-capacityprovider-rich deploy.
  'AWS::ECS::CapacityProvider': {
    'AutoScalingGroupProvider.ManagedDraining': 'ENABLED',
  },
  // AWS Backup materializes these defaults into each live BackupPlanRule (keyed by RuleName
  // — descended via NESTED_ARRAY_IDENTITY). Folding them keeps a clean plan clean; an
  // out-of-band change away from one still surfaces (equality-gated). Proven live: a
  // CDK-default daily rule reads back StartWindowMinutes 480 / CompletionWindowMinutes 10080
  // / ScheduleExpressionTimezone Etc/UTC (the empty CopyActions/ScanActions/IndexActions/
  // RecoveryPointTags fold via isTrivialEmpty).
  'AWS::Backup::BackupPlan': {
    'BackupPlan.BackupPlanRule.*.CompletionWindowMinutes': 10080,
    'BackupPlan.BackupPlanRule.*.StartWindowMinutes': 480,
    'BackupPlan.BackupPlanRule.*.ScheduleExpressionTimezone': 'Etc/UTC',
  },
  // AWS Data Lifecycle Manager materializes these constants into every live custom
  // EBS-snapshot policy the template leaves unset: ResourceLocations defaults to ["CLOUD"]
  // (vs an Outpost), PolicyLanguage to "STANDARD", each schedule's CreateRule.Location to
  // "CLOUD", and a Count-based RetainRule reads back Interval 0 (the interval-based
  // alternative unused). Schedules are keyed by Name (auto-detected identity). Folding keeps
  // a clean policy clean; a real change away from any default still surfaces (equality-gated).
  // Proven live on a minimal daily-backup policy (issue #468).
  'AWS::DLM::LifecyclePolicy': {
    'PolicyDetails.ResourceLocations': ['CLOUD'],
    'PolicyDetails.PolicyLanguage': 'STANDARD',
    'PolicyDetails.Schedules.*.CreateRule.Location': 'CLOUD',
    'PolicyDetails.Schedules.*.RetainRule.Interval': 0,
  },
  // AWS Route53 Resolver materializes a FirewallDomainRedirectionAction default into each
  // live FirewallRule (keyed by Priority — descended via NESTED_ARRAY_IDENTITY).
  // Equality-gated, so a rule changed away from the default still surfaces. Proven live on a
  // CDK-default BLOCK rule. (The sibling FirewallThreatProtectionId is readOnly — stripped
  // before the nested loop — so it needs no entry here.)
  'AWS::Route53Resolver::FirewallRuleGroup': {
    'FirewallRules.*.FirewallDomainRedirectionAction': 'INSPECT_REDIRECTION_DOMAIN',
  },
  // AWS materializes the default AWS-managed KMS key into each live replica region (keyed
  // by Region — descended via NESTED_ARRAY_IDENTITY) when the replica declares no KmsKeyId.
  // Folding keeps a clean multi-region secret clean; a replica re-keyed to a different CMK
  // out of band no longer matches and surfaces. Proven live.
  'AWS::SecretsManager::Secret': {
    'ReplicaRegions.*.KmsKeyId': 'alias/aws/secretsmanager',
  },
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
  // AWS materializes the caching scalar default into every live MethodSettings element
  // (keyed by HttpMethod — descended via NESTED_ARRAY_IDENTITY) when the stage declares
  // only throttling/tracing. Folding keeps a clean stage clean; a method whose cache TTL
  // was changed out of band no longer matches and surfaces. The sibling defaults
  // CacheDataEncrypted / CachingEnabled / MetricsEnabled all read back `false` and fold via
  // isTrivialEmpty (so enabling any of them out of band — a non-`false` value — surfaces).
  // The two Throttling* defaults are the account-level API Gateway throttle limits AWS
  // applies to every method that declares no per-method throttle (rate 10000 req/s,
  // burst 5000 — the documented account defaults). A stage that never set throttling
  // otherwise reports both on every first run as undeclared drift. Equality-gated: a
  // method pinned to a different limit (or an account whose quota was raised) no longer
  // matches and surfaces. Proven live (RestApi DeploymentStage with no method throttle).
  'AWS::ApiGateway::Stage': {
    'MethodSettings.*.CacheTtlInSeconds': 300,
    'MethodSettings.*.ThrottlingBurstLimit': 5000,
    'MethodSettings.*.ThrottlingRateLimit': 10000,
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
    // A DECLARED standard schema attribute (email/name, keyed by Name via
    // NESTED_ARRAY_IDENTITY) that omits its data type / string constraints reads back
    // Cognito's constant defaults: a String attribute with a 0..2048 length range. The
    // whole live-only standard attributes fold via IDENTITY_KEYED_DEFAULT_ELEMENTS, but a
    // PARTIALLY-declared one (Required/Mutable set, type left to AWS) surfaces these two
    // AWS-filled sub-keys instead. Equality-gated: a Number attribute reads a non-String
    // type, and a custom-constrained String reads a non-matching range, so both surface.
    'Schema.*.AttributeDataType': 'String',
    'Schema.*.StringAttributeConstraints': { MinLength: '0', MaxLength: '2048' },
  },
  // A Google (or any social/OIDC) identity provider declares only its credentials
  // (client_id / client_secret / authorize_scopes) and attribute mappings; Cognito
  // DERIVES and returns the provider's well-known OIDC endpoints and its default
  // username->sub mapping, which the template never carries, so a fresh provider floods
  // every first run with these live-only sub-keys. They are Cognito-injected provider
  // metadata, not user intent. Equality-gated to Google's constant endpoints, so a
  // different provider's URLs (or a value AWS changes) do not match and surface.
  // Observed live on a dev Google IdP.
  'AWS::Cognito::UserPoolIdentityProvider': {
    'ProviderDetails.authorize_url': 'https://accounts.google.com/o/oauth2/v2/auth',
    'ProviderDetails.token_url': 'https://www.googleapis.com/oauth2/v4/token',
    'ProviderDetails.attributes_url': 'https://people.googleapis.com/v1/people/me?personFields=',
    'ProviderDetails.oidc_issuer': 'https://accounts.google.com',
    'ProviderDetails.token_request_method': 'POST',
    'ProviderDetails.attributes_url_add_attributes': 'true',
    'AttributeMapping.username': 'sub',
  },
  // A REGIONAL RestApi (EndpointConfiguration declares only Types:['REGIONAL']) reads
  // back EndpointConfiguration.IpAddressType: 'ipv4' — the server default the template
  // never sets. The whole-object KNOWN_DEFAULTS entry only covers the EDGE default shape,
  // so a REGIONAL api's IpAddressType surfaces as an undeclared sub-key; fold the path
  // here. Equality-gated: a dualstack api no longer matches and surfaces. Observed live.
  'AWS::ApiGateway::RestApi': {
    'EndpointConfiguration.IpAddressType': 'ipv4',
  },
  'AWS::DynamoDB::Table': {
    'PointInTimeRecoverySpecification.RecoveryPeriodInDays': 35,
    // A table that declares only `ContributorInsightsSpecification.Enabled: true` reads back
    // the service-default Mode `ACCESSED_AND_THROTTLED_KEYS` (the mode AWS applies when
    // Contributor Insights is enabled without an explicit Mode) — the template never carries
    // it, so it floods the first check as an undeclared sibling of the declared `Enabled`.
    // Equality-gated: a table that pins the other mode (`THROTTLED_KEYS`) or one AWS changes
    // out of band no longer matches and re-surfaces. The same spec can also sit on each GSI
    // (`GlobalSecondaryIndexes.*.ContributorInsightsSpecification`), so fold the Mode there
    // too. Live-proven 2026-07-08 #649.
    'ContributorInsightsSpecification.Mode': 'ACCESSED_AND_THROTTLED_KEYS',
    'GlobalSecondaryIndexes.*.ContributorInsightsSpecification.Mode': 'ACCESSED_AND_THROTTLED_KEYS',
    // A table with `SSESpecification.SSEEnabled: true` and no explicit `SSEType` reads back
    // `SSEType: 'KMS'` — the only value AWS assigns when server-side encryption is enabled
    // without a type (the AWS-managed / customer-managed KMS path). The template omits it, so
    // it is undeclared first-run noise. Equality-gated so a future/other SSEType still
    // surfaces. Live-proven 2026-07-08 #649.
    'SSESpecification.SSEType': 'KMS',
  },
  // AWS::DynamoDB::GlobalTable shares the SSE/ContributorInsights shapes with the classic
  // ::Table (#523 twin-type), but with GlobalTable's own nesting: SSESpecification (the
  // SSEEnabled/SSEType pair) is top-level, while ContributorInsightsSpecification lives per
  // replica (`Replicas.*.ContributorInsightsSpecification`) and per replica GSI
  // (`Replicas.*.GlobalSecondaryIndexes.*.ContributorInsightsSpecification`). Register the
  // same equality-gated Mode/SSEType folds at those paths so a GlobalTable deployed with the
  // same common flags is CLEAN first-run too. The top-level SSEType fold is reachable today;
  // the per-replica Mode/KMSMasterKeyId folds additionally need the `Replicas` array keyed by
  // `Region` in NESTED_ARRAY_IDENTITY (classify.ts) for the undeclared descent to align each
  // replica — the entries here are the noise-side twin, forward-compatible and equality-gated.
  // (GlobalTable's KMSMasterKeyId lives per replica under `Replicas.*.SSESpecification` and is
  // folded value-independently via GENERATED_NESTED_PATHS below.) Mirrors #649.
  'AWS::DynamoDB::GlobalTable': {
    'SSESpecification.SSEType': 'KMS',
    'Replicas.*.ContributorInsightsSpecification.Mode': 'ACCESSED_AND_THROTTLED_KEYS',
    'Replicas.*.GlobalSecondaryIndexes.*.ContributorInsightsSpecification.Mode':
      'ACCESSED_AND_THROTTLED_KEYS',
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
    // A service that enables the deployment circuit breaker reads back these AWS-filled
    // sub-defaults (reset the deployment count once a task is healthy, and the built-in
    // BOUNDED_PERCENT / 50% failure threshold). Observed live on a fresh Fargate service.
    'DeploymentConfiguration.DeploymentCircuitBreaker.ResetOnHealthyTask': true,
    'DeploymentConfiguration.DeploymentCircuitBreaker.ThresholdConfiguration': {
      Type: 'BOUNDED_PERCENT',
      Value: 50,
    },
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
    // A destination declaring no compression / encryption reads back the AWS defaults:
    // UNCOMPRESSED delivery and no server-side encryption. Observed live.
    'ExtendedS3DestinationConfiguration.CompressionFormat': 'UNCOMPRESSED',
    'ExtendedS3DestinationConfiguration.EncryptionConfiguration': {
      NoEncryptionConfig: 'NoEncryption',
    },
  },
  'AWS::Athena::WorkGroup': {
    // A workgroup that declares no configuration reads back AWS's defaults: the config is
    // enforced on member queries, the engine version auto-selects, and CloudWatch query
    // metrics are published. Observed live. These fold when WorkGroupConfiguration is DESCENDED
    // (DESCEND_UNDECLARED_OBJECT_PATHS, #565) because a non-default sibling made the whole
    // object miss the whole-object fold; RequesterPaysEnabled:false folds as trivially-empty.
    'WorkGroupConfiguration.EnforceWorkGroupConfiguration': true,
    'WorkGroupConfiguration.EngineVersion': { SelectedEngineVersion: 'AUTO' },
    'WorkGroupConfiguration.PublishCloudWatchMetricsEnabled': true,
  },
  'AWS::EKS::Cluster': {
    // A cluster that declares SubnetIds (partially declaring ResourcesVpcConfig, so it is
    // descended) reads back AWS's endpoint defaults on the sibling sub-keys. Constants,
    // equality-gated. Observed live (hunt 2026-07-03 round E).
    'ResourcesVpcConfig.EndpointPublicAccess': true,
    'ResourcesVpcConfig.PublicAccessCidrs': ['0.0.0.0/0'],
    'ResourcesVpcConfig.ControlPlaneEgressMode': 'AWS_MANAGED',
    // KubernetesNetworkConfig is fully undeclared, so it is DESCENDED via
    // DESCEND_UNDECLARED_OBJECT_PATHS (#555). IpFamily is the constant "ipv4" default (the
    // only alternative, "ipv6", is an explicit opt-in); ElasticLoadBalancing {Enabled:false}
    // folds as trivially-empty, leaving only the per-deploy ServiceIpv4Cidr as residue.
    'KubernetesNetworkConfig.IpFamily': 'ipv4',
  },
  'AWS::ApplicationSignals::ServiceLevelObjective': {
    // An SLO goal that declares no warning threshold reads back the 50(%) default.
    // Observed live. Equality-gated, so a custom threshold still surfaces.
    'Goal.WarningThreshold': 50,
  },
  // R-noise-sweep (offline corpus audit): nested constant defaults the schema does
  // not annotate. Equality-gated; a non-default value still surfaces.
  'AWS::WAFv2::WebACL': {
    // A rate-based rule with no explicit window reads back the 5-minute (300s) default.
    'Rules.*.Statement.RateBasedStatement.EvaluationWindowSec': 300,
  },
  'AWS::WAFv2::RuleGroup': {
    // A RuleGroup hosts the SAME rate-based statement shape as a WebACL, so an
    // undeclared rate-based window reads back the identical 5-minute (300s) default.
    // Observed live on a fresh wafv2-ratecustomkeys deploy (issue #440).
    'Rules.*.Statement.RateBasedStatement.EvaluationWindowSec': 300,
  },
  'AWS::SES::EmailIdentity': {
    // A custom MAIL FROM domain reads back the documented default fallback behavior.
    'MailFromAttributes.BehaviorOnMxFailure': 'USE_DEFAULT_VALUE',
  },
  'AWS::SES::ReceiptRule': {
    // A rule that does not declare a TLS policy reads back the documented "Optional"
    // default. Equality-gated, so a rule switched to "Require" out of band still surfaces.
    // (The sibling Enabled / ScanEnabled booleans default false and fold via isTrivialEmpty.)
    'Rule.TlsPolicy': 'Optional',
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
  // DataSync task nested service defaults (observed live on hunt 2026-07-03 round B,
  // #496; TaskQueueing + PreserveDeletedFiles added on hunt 2026-07-07): a task whose
  // declared `Options` block leaves these unset reads them back at the documented
  // transfer defaults, and a declared `Schedule` reads back Status ENABLED (the schedule
  // is active on create). Equality-gated per path — a task that pins any Option / disables
  // its schedule out of band no longer matches and surfaces. Per-input BytesPerSecond -1
  // is the documented "unlimited" sentinel. TaskQueueing defaults ENABLED and
  // PreserveDeletedFiles defaults PRESERVE (both live-verified undeclared on the
  // datasync-rich fixture — the two the round-B entry missed).
  'AWS::DataSync::Task': {
    'Options.Atime': 'BEST_EFFORT',
    'Options.Mtime': 'PRESERVE',
    'Options.Uid': 'NONE',
    'Options.Gid': 'NONE',
    'Options.PreserveDevices': 'NONE',
    'Options.PosixPermissions': 'NONE',
    'Options.ObjectTags': 'PRESERVE',
    'Options.BytesPerSecond': -1,
    'Options.SecurityDescriptorCopyFlags': 'NONE',
    'Options.TaskQueueing': 'ENABLED',
    'Options.PreserveDeletedFiles': 'PRESERVE',
    'Schedule.Status': 'ENABLED',
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
  // The live read echoes the rule's own ARN (== the resource's physical id) inside
  // the declared SamplingRule object — pure identity, never user-editable.
  // Observed live on the xray-insightrule-rich fixture.
  'AWS::XRay::SamplingRule': ['SamplingRule.RuleARN'],
};

// Top-level UNDECLARED keys whose service default VALUE is derived from the READ
// CONTEXT (the resource's own region), which a constant KNOWN_DEFAULTS entry cannot
// express. Kinds: 'region' (the scalar region), 'regionList' (a single-element list
// of the own region). Equality-gated against the resolved context like every default
// fold — a value that differs (extra regions added out of band) no longer matches
// and surfaces as real undeclared drift; with NO resolved region the value simply
// stays `undeclared` (recordable), never a wrong fold. First case (observed live on
// a fresh iot-vpces-rich deploy, issue #462): a VPC endpoint service that declares
// no SupportedRegions reads back `[<own region>]`.
export const CONTEXT_DEFAULTS: Record<string, Record<string, 'region' | 'regionList'>> = {
  'AWS::EC2::VPCEndpointService': { SupportedRegions: 'regionList' },
};

// Top-level UNDECLARED keys whose default VALUE is an ARN derived from the resource's own
// deploy context — partition, region, account id — which neither a constant KNOWN_DEFAULTS
// entry nor the region-only CONTEXT_DEFAULTS above can express. The template uses the
// placeholders {partition}/{region}/{accountId}, substituted from the read opts and equality-
// gated against the live value: a resource that points the property at a DIFFERENT scope / key
// still surfaces as real undeclared drift (detection preserved, unlike a value-independent
// fold). With no resolved account/region the substitution is skipped and the value stays
// `undeclared` (recordable), never a wrong fold.
export const CONTEXT_ARN_DEFAULTS: Record<string, Record<string, string>> = {
  // A ResourceExplorer2 View that declares no Scope reads back the account-root ARN — the
  // whole-account default scope. createOnly (never drifts), but derived rather than value-
  // independent per the fold-strategy order. Live, hunt 2026-07-08 round F (#626).
  'AWS::ResourceExplorer2::View': { Scope: 'arn:{partition}:iam::{accountId}:root' },
  // A Kinesis Video stream that declares no KMS key reads back the AWS-managed
  // `alias/aws/kinesisvideo` key ARN — f(partition, region, account). Equality-gated, so a
  // stream switched to a customer CMK (a real, mutable change) still surfaces. Live, hunt
  // 2026-07-08 round E (#624).
  'AWS::KinesisVideo::Stream': {
    KmsKeyId: 'arn:{partition}:kms:{region}:{accountId}:alias/aws/kinesisvideo',
  },
};

// Top-level UNDECLARED keys whose service default VALUE is derived from the resource's own
// live ENGINE (RDS) — the engine-conditional twin of CONTEXT_DEFAULTS (region-derived) and
// KNOWN_DEFAULTS (constant). A single constant cannot express these because the default
// differs per engine family (aurora-mysql `StorageType`="aurora" vs a provisioned MySQL's
// "gp2", MySQL `Port`=3306 vs Postgres 5432), which is why the original KNOWN_DEFAULTS
// comment left them unfolded — but that flooded every clean CDK Aurora first run with 4-7
// potential-drift lines for values the user never set and (for the create-only ones) can
// never change. Each entry maps the live `Engine` string to the default value, or `undefined`
// when this engine has no single default (then the value stays `undeclared`, recordable).
// Equality-gated with typed<->string coercion (a DBInstance echoes the port/storage as a
// STRING "3306"/"1" while a DBCluster carries the NUMBER): a value that differs from the
// engine default no longer matches and surfaces as real undeclared drift. Aurora is
// create-only on StorageType, so its fold hides nothing revertable.
export const ENGINE_DEFAULTS: Record<string, Record<string, (engine: string) => unknown>> = {
  'AWS::RDS::DBInstance': {
    StorageType: (e) => (e.startsWith('aurora') ? 'aurora' : undefined),
    AllocatedStorage: (e) => (e.startsWith('aurora') ? 1 : undefined),
    Port: rdsDefaultPort,
    LicenseModel: rdsDefaultLicense,
  },
  'AWS::RDS::DBCluster': {
    StorageType: (e) => (e.startsWith('aurora') ? 'aurora' : undefined),
    AllocatedStorage: (e) => (e.startsWith('aurora') ? 1 : undefined),
    Port: rdsDefaultPort,
  },
};

// RDS engine-family default listener port. Only families with a single well-known default
// are listed; an unknown engine returns undefined (no fold).
function rdsDefaultPort(engine: string): number | undefined {
  if (/mysql|maria/.test(engine)) return 3306;
  if (/postgres/.test(engine)) return 5432;
  if (/oracle/.test(engine)) return 1521;
  if (/sqlserver/.test(engine)) return 1433;
  return undefined;
}

// RDS engine-family default LicenseModel. MySQL/MariaDB/Aurora-MySQL read back
// "general-public-license"; Postgres/Aurora-Postgres "postgresql-license". Oracle/SQLServer
// carry BYOL/license-included with no single default, so they return undefined (no fold).
function rdsDefaultLicense(engine: string): string | undefined {
  if (/postgres/.test(engine)) return 'postgresql-license';
  if (/mysql|maria/.test(engine)) return 'general-public-license';
  return undefined;
}

// Top-level UNDECLARED keys whose value is an AWS-MANAGED default resource NAME, recognizable
// by a `default`-family prefix rather than a constant. An RDS instance that pins no custom
// parameter/option group reads back the engine's DEFAULT group — `DBParameterGroupName`
// "default.aurora-mysql8.0" / "default.mysql8.0", `OptionGroupName` "default:aurora-mysql-8-0"
// / "default:mysql-8-0". The `default.` / `default:` prefix is reserved by AWS for these
// managed groups, so a CUSTOM group (whose name never starts with that prefix — observed in
// the corpus, e.g. "cdkrealdriftintegaurorarich-instancepg…") still surfaces as real
// undeclared inventory. Version-independent (matches any `default.<engine><ver>`), so it does
// not go stale as KNOWN_DEFAULTS constants would.
export const DEFAULT_MANAGED_NAME_PATHS: Record<string, Record<string, RegExp>> = {
  'AWS::RDS::DBInstance': {
    DBParameterGroupName: /^default\./,
    OptionGroupName: /^default:/,
  },
  // The RDS-family + cache engines mirror the RDS `default.<engine><version>` precedent: a
  // cluster/instance/cache that declares no explicit parameter group reads back the AWS-managed
  // default group name (`default.redis7`, `default.docdb5.0`, `default.neptune1.3`,
  // `default.redshift-2.0`, `default.memorydb-redis7`). The name is version-derived (not a
  // pinnable constant), so it is regex-matched — a CUSTOM group name a user attached does not
  // start with `default.` and still surfaces. Undeclared-only, like the RDS precedent. Found by
  // the offline first-run-noise sweep across the corpus.
  'AWS::ElastiCache::CacheCluster': { CacheParameterGroupName: /^default\./ },
  'AWS::DocDB::DBCluster': { DBClusterParameterGroupName: /^default\./ },
  'AWS::Neptune::DBCluster': { DBClusterParameterGroupName: /^default\./ },
  'AWS::Neptune::DBInstance': { DBParameterGroupName: /^default\./ },
  'AWS::Redshift::Cluster': { ClusterParameterGroupName: /^default\./ },
  'AWS::MemoryDB::Cluster': { ParameterGroupName: /^default\./ },
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
  // A standalone SG rule that references another security group (self-ref or peer) reads back
  // a SourceSecurityGroupOwnerId AWS injects — the account that owns the referenced SG. The
  // template never declares it (CDK derives it from SourceSecurityGroupId), so on a fresh
  // self-referencing SG rule — the canonical ALB↔ASG / intra-cluster pattern — it floods the
  // first run as undeclared. It is tied to SourceSecurityGroupId (which IS compared), not an
  // independently-editable property, so folding it `generated` (inventory: never drift) is
  // safe; a meaningful change is a change to SourceSecurityGroupId itself. Observed live on
  // the securitygroup-protocols-rich fixture's self-ref rule.
  // A standalone SG rule reads back the GroupName of the SG it attaches to (CDK derives
  // the rule from GroupId, never declaring GroupName), so it floods a self-ref/peer rule's
  // first run as undeclared. Tied to GroupId (which IS compared), not independently
  // editable — a meaningful change is a change to the target SG. Observed live.
  'AWS::EC2::SecurityGroupIngress': new Set(['SourceSecurityGroupOwnerId', 'GroupName']),
  // An awsvpc/Fargate ECS service that declares no service role reads back the AWS-injected
  // service-linked role ARN (`.../aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`).
  // AWS-managed, not user intent, present on every such service. A service that DOES declare
  // a Role (classic-ELB pattern) carries it in the template and never reaches this loop.
  'AWS::ECS::Service': new Set(['Role']),
  // A Secret whose Name the template omits reads back a CloudFormation-generated name
  // (`<constructId>-<random>` — NO stack prefix, so isCfnGeneratedName misses it). It is the
  // AWS-minted identity, not user intent; a Secret that DECLARES a Name carries it in the
  // template and never reaches this loop.
  'AWS::SecretsManager::Secret': new Set(['Name']),
  // A target group's `Targets` that the template does not declare holds the targets AWS/ECS
  // registered at RUNTIME (dynamic task IPs) — not template intent, and they churn as tasks
  // recycle, so surfacing them as recordable drift is non-actionable (a record snapshot
  // immediately re-drifts). A group that DECLARES static Targets carries them in the template
  // and is compared normally, so a removed/changed static target still surfaces.
  'AWS::ElasticLoadBalancingV2::TargetGroup': new Set(['Targets']),
  // An Application Auto Scaling policy attached to a target via ScalingTargetId (the CDK
  // pattern) reads back the target's ResourceId / ServiceNamespace / ScalableDimension,
  // which AWS derives from the target and the template never declares. They echo the
  // scalable target's identity, not independent settings. Observed live on an ECS
  // service-scaling policy.
  'AWS::ApplicationAutoScaling::ScalingPolicy': new Set([
    'ResourceId',
    'ServiceNamespace',
    'ScalableDimension',
  ]),
  // A published version's CodeSha256 is the base64 hash of the deployed code package —
  // a per-deploy, opaque, service-minted value (NOT a constant default, so KNOWN_DEFAULTS
  // cannot fold it). It is live-only ONLY when the template does not pin it; a version
  // that DECLARES CodeSha256 (to gate publication on specific code) carries it in the
  // template and never reaches the undeclared loop. Folding the live-only case as
  // `generated` (inventory: never drift, never recorded, never reverted) stops every
  // `currentVersion` in a stack flooding the first run — observed across a 7-function
  // stack. The version resource is immutable, so the hash can never be an out-of-band edit.
  'AWS::Lambda::Version': new Set(['CodeSha256']),
  // An EFS AccessPoint's ClientToken is the idempotency token CloudFormation mints at
  // create time as `<logicalId>-<random>` (e.g. "AccessPointE936DE82-b6xKi37R0Uio"). It
  // is createOnly (immutable) and the CDK L2 never declares it, so it floods the first
  // run as undeclared on every AccessPoint. The value is opaque and not derivable from
  // the physical id (an fsap-… ARN), so neither isGeneratedName nor a physical-id echo
  // folds it. A raw-CFn user who DOES set ClientToken carries it in the template and
  // never reaches this undeclared loop, so folding the live-only case as `generated`
  // (inventory: never drift, recorded, or reverted) is safe — and necessary, since an
  // immutable token can never be an out-of-band edit. Observed live on lambda-efs-rich.
  'AWS::EFS::AccessPoint': new Set(['ClientToken']),
  // NOTE: AWS::Lambda::LayerVersion.LayerName is NOT folded here. The flood case — a CDK
  // BucketDeployment's AwsCliLayer reads back its own logical id verbatim — is handled
  // PRECISELY by isCfnGeneratedName's `value === logicalId` echo (classify.ts). A
  // value-independent GENERATED_TOPLEVEL_PATHS entry would additionally fold an undeclared
  // user-set LayerName (e.g. "my-custom-layer") that is NOT the logical id, hiding real
  // undeclared drift — the exact differentiator cdkrd exists to surface.
  // NOTE: AWS::Cognito::UserPoolClient.ClientName is NOT folded here either. Its generated
  // form is `<logicalId>-<random>` (no stack prefix), now folded value-DEPENDENTLY via
  // GENERATED_LOGICALID_PREFIX_PATHS below. A value-independent entry would additionally
  // fold an undeclared user-set ClientName that is NOT the logical-id form, hiding real
  // undeclared drift.
};

// FULLY-undeclared top-level OBJECT properties to DESCEND into leaf-by-leaf instead of
// reporting whole (#555). A fully-undeclared object is normally one `undeclared` finding, so
// its constant sub-keys (which KNOWN_DEFAULT_PATHS folds only inside a PARTIALLY-declared —
// thus descended — object) can't fold; the whole object surfaces even when only ONE leaf is
// record-worthy. Listing (type → top-level path) here descends that object through the SAME
// nested machinery: known-default / generated / trivially-empty leaves fold (atDefault /
// generated / dropped) and only the non-default residue surfaces (nested, at `Prop.sub`).
//
// CURATED, not "every fully-undeclared object": a blanket descend would FRAGMENT objects with
// no foldable defaults (a VPCEndpoint `PolicyDocument`, an S3 `NotificationConfiguration`) into
// noisier per-leaf findings — strictly worse. Only add a (type, path) whose leaves genuinely
// split into "constant AWS defaults + a small record-worthy residue", with the residue's
// constants registered in KNOWN_DEFAULT_PATHS. EKS `KubernetesNetworkConfig` is the first: AWS
// materializes `IpFamily: "ipv4"` (constant, folds) and `ElasticLoadBalancing: {Enabled:false}`
// (trivially-empty, dropped), leaving only `ServiceIpv4Cidr` (10.100 or 172.20 per deploy) —
// the single value worth recording.
export const DESCEND_UNDECLARED_OBJECT_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::EKS::Cluster': new Set(['KubernetesNetworkConfig']),
  // A workgroup that declares no WorkGroupConfiguration reads back AWS's whole default config;
  // when it matches the default exactly the whole-object KNOWN_DEFAULTS fold (above) folds it
  // atDefault. But once ONE sub-key is set out of band (a ResultConfiguration output location, a
  // BytesScannedCutoffPerQuery cap) the whole object no longer matches and surfaces WHOLE,
  // obscuring which sub-key changed. Descend so the four constant defaults fold
  // (EnforceWorkGroupConfiguration / EngineVersion / PublishCloudWatchMetricsEnabled via
  // KNOWN_DEFAULT_PATHS, RequesterPaysEnabled:false as trivially-empty) and only the record-
  // worthy residue surfaces. Every other sub-key is a meaningful config value (not noise), so
  // fragmenting is the desired behavior here. Follow-up to #555 (#565).
  'AWS::Athena::WorkGroup': new Set(['WorkGroupConfiguration']),
  // A Kinesis Video stream that declares no StreamStorageConfiguration reads back the whole
  // default object {DefaultStorageTier:"HOT"} — a FULLY-undeclared object whose only leaf is
  // schema-`default`-annotated (HOT). The top-level undeclared loop consults only KNOWN_DEFAULTS
  // / schema.defaults (top-level), so the object surfaced whole; descend it so DefaultStorageTier
  // folds via schema.defaultPaths and only a non-default residue (a WARM tier set out of band)
  // would surface. Live, hunt 2026-07-08 round E (#624).
  'AWS::KinesisVideo::Stream': new Set(['StreamStorageConfiguration']),
};

// Value-DEPENDENT generated-name fold, scoped by type + top-level path. Folds a live value
// to `generated` ONLY when it is the `<logicalId><sep><random>` CFn auto-generated form — the
// resource's logical id, a `-` or `_` separator, then CFn's 12+ char random suffix — for a type
// whose no-explicit-name physical name takes that shape WITHOUT a `<stack>-` prefix (so the
// isCfnGeneratedName stack-prefix branches miss it). UNLIKE the value-independent
// GENERATED_TOPLEVEL_PATHS, an undeclared user-SET name (no logical-id prefix) does NOT match
// and still surfaces as real drift. Deliberately NOT applied generically in
// isCfnGeneratedName: a short raw-CFn logical id (e.g. a WAFv2 RegexPatternSet's `RegexSet`)
// carries no construct hash, so `<logicalId>-<random>` would coincide with genuine undeclared
// names and over-fold — this table gates it to the specific types/paths observed to need it.
//   AWS::Cognito::UserPoolClient.ClientName — reads back `<logicalId>-<random>` when the
//   template declares no ClientName (observed live).
//   AWS::Cognito::IdentityPool.IdentityPoolName — reads back `<logicalId>_<random>` when the
//   template declares no IdentityPoolName (observed live: logical id "IdPool" →
//   "IdPool_r5WzZ9554da2"). The separator is an underscore, not a hyphen — identity-pool
//   names use a different generated form — so isLogicalIdPrefixedGeneratedName accepts both.
//   AWS::Cognito::UserPool.UserPoolName — reads back `<logicalId>-<random>` when the template
//   declares no UserPoolName (observed live across corpus: "Pool88FC4FF9F-jVGU9rNojAd7",
//   "Users0A0EEA89-RYUoEBfJwQHo"). Same class as the sibling ClientName — audited in.
//   AWS::Batch::JobDefinition.JobDefinitionName — reads back `<logicalId>-<random>` when the
//   template declares no JobDefinitionName (observed live across corpus:
//   "JobDef97B0969F-HFfibEW0TJakGN1M"). The logical id carries a CDK construct hash, so the
//   `<logicalId>-<random>` gate cannot coincide with a genuine user-set name.
export const GENERATED_LOGICALID_PREFIX_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::Cognito::UserPoolClient': new Set(['ClientName']),
  'AWS::Cognito::IdentityPool': new Set(['IdentityPoolName']),
  'AWS::Cognito::UserPool': new Set(['UserPoolName']),
  'AWS::Batch::JobDefinition': new Set(['JobDefinitionName']),
};

// True when `value` is the `<logicalId><sep><random>` CFn auto-generated-name form: the logical
// id, a `-` OR `_` separator, then CFn's random suffix. Consulted only for
// GENERATED_LOGICALID_PREFIX_PATHS entries. Pure + exported for unit tests.
const CFN_LOGICALID_RANDOM = /[-_][0-9A-Za-z]{12,}$/;
export function isLogicalIdPrefixedGeneratedName(value: unknown, logicalId: string): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(`${logicalId}-`) || value.startsWith(`${logicalId}_`)) &&
    CFN_LOGICALID_RANDOM.test(value)
  );
}

// Like GENERATED_TOPLEVEL_PATHS but for NESTED, value-INDEPENDENT paths (dotted, `*` for
// array crossings) — a sub-key AWS/CloudFormation injects that the template never declares
// and whose value is not derivable from the physical id (so isPhysicalIdSegment can't gate
// it). Folded `generated` (inventory: never drift, recorded, or reverted) only in the
// LIVE-only case: a user who DECLARES the sub-key carries it in the template and never
// reaches the undeclared loop, so a meaningful out-of-band change to a declared value still
// surfaces via the declared compare.
//   AWS::KMS::Key.KeyPolicy.Id — CloudFormation injects a doc-level policy `Id` (the stack
//   name) into a key policy that omits one, so a first check of a key with a default/simple
//   policy floods `KeyPolicy.Id` as undeclared. It is cosmetic (a policy label, like a
//   statement Sid) and stack-derived, not user intent.
export const GENERATED_NESTED_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::KMS::Key': new Set(['KeyPolicy.Id']),
  // An ECR repository's lifecycle policy reads back a RegistryId AWS injects (the owning
  // account id) that the template never declares — folded regardless of value.
  'AWS::ECR::Repository': new Set(['LifecyclePolicy.RegistryId']),
  // A Lambda function that declares no custom log group reads back the AWS-created default
  // `/aws/lambda/<functionName>`. The whole-object GENERATED_DEFAULTS fold misses it when the
  // function ALSO carries a non-default LogFormat/ApplicationLogLevel (so the object differs);
  // fold the LogGroup path itself, value-independently — a CUSTOM log group is DECLARED and
  // compared in the declared loop, never reaching here.
  'AWS::Lambda::Function': new Set(['LoggingConfig.LogGroup']),
  // An OpenSearch domain that declares no explicit KMS key reads back the AWS-assigned key id
  // (a GUID) inside EncryptionAtRestOptions — never a constant, never user intent when undeclared
  // (like RDS KmsKeyId). Live-verified undeclared on a fresh opensearch-rich deploy.
  'AWS::OpenSearchService::Domain': new Set(['EncryptionAtRestOptions.KmsKeyId']),
  // A stage with a declared canary reads back a CanarySetting.DeploymentId AWS materializes at
  // creation — the canary starts pointed at the stage's current deployment, so AWS fills the id
  // the template's CanarySetting omits. Per-resource AWS-assigned identifier (the canary-nested
  // twin of the stage's own top-level DeploymentId, which already folds `generated`), so fold it
  // value-independently. Live, hunt 2026-07-08 round G (#633).
  'AWS::ApiGateway::Stage': new Set(['CanarySetting.DeploymentId']),
  // A DynamoDB table with `SSESpecification.SSEEnabled: true` and no explicit KMS key reads
  // back `SSESpecification.KMSMasterKeyId` = the account's AWS-managed `alias/aws/dynamodb`
  // key ARN (a per-account, AWS-assigned GUID — the account-default-KMS echo class, exactly
  // like the RDS/OpenSearch `KmsKeyId` folds above). It is never a constant we can pin (it
  // embeds the per-account key id) and never user intent when undeclared: the CFn schema note
  // says to set KMSMasterKeyId "only if the key is different from the default DynamoDB key
  // alias/aws/dynamodb". Fold value-independent — a user who wants a customer-managed key
  // DECLARES KMSMasterKeyId, which is then compared in the declared loop (detected) and never
  // reaches here. For GlobalTable the key sits per replica under
  // `Replicas.*.SSESpecification.KMSMasterKeyId`. Live-proven 2026-07-08 #649.
  'AWS::DynamoDB::Table': new Set(['SSESpecification.KMSMasterKeyId']),
  'AWS::DynamoDB::GlobalTable': new Set(['Replicas.*.SSESpecification.KMSMasterKeyId']),
};

// Elastic Beanstalk ConfigurationTemplate `OptionSettings` first-run default fold. A template
// declares a handful of option settings; AWS materializes the FULL resolved set (~50 for a
// SingleInstance env, ~80 for LoadBalanced) keyed by `Namespace|OptionName`. Every extra the
// template never declared is an AWS default and must fold to atDefault (the zero-potential-
// drift invariant), while a change AWAY from the default must still surface. The composite-key
// subset surfacing (classify.ts) consults `ebOptionSettingTier` per live-only entry.
//
// Three tiers per the CLAUDE.md fold-strategy order:
//  - EB_OPTION_DEFAULTS — equality-gated constants: fold when the live value equals the pinned
//    default; a change away surfaces (detection kept). The default choice.
//  - EB_OPTION_DERIVED — the default is a deterministic function of the sibling `EnvironmentType`
//    option (SingleInstance vs LoadBalanced), so compute it and equality-gate the computed value
//    (detection kept). MaxSize (1 vs 4) and the spot on-demand-above-base % (0 vs 70) observed live.
//  - EB_OPTION_VALUE_INDEPENDENT — last resort: AWS-assigned values that MOVE (the platform AMI id,
//    the versioned sample-app / hooks S3 URLs, the health ConfigDocument blob, the derived instance
//    type family) or a per-resource `{Ref}` (the ELB security group). Folds any value → loses
//    change-detection; acceptable only because it is undeclared (declare the option to detect it).
// Values pinned from a live SingleInstance + LoadBalanced ConfigurationTemplate pair (2026-07-07).
export const EB_OPTION_DEFAULTS: Record<string, string> = {
  'aws:autoscaling:asg|Availability Zones': 'Any',
  'aws:autoscaling:asg|Cooldown': '360',
  'aws:autoscaling:asg|EnableCapacityRebalancing': 'false',
  'aws:autoscaling:asg|MinSize': '1',
  'aws:autoscaling:launchconfiguration|DisableDefaultEC2SecurityGroup': 'false',
  'aws:autoscaling:launchconfiguration|DisableIMDSv1': 'true',
  'aws:autoscaling:launchconfiguration|MonitoringInterval': '5 minute',
  'aws:autoscaling:launchconfiguration|SSHSourceRestriction': 'tcp,22,22,0.0.0.0/0',
  'aws:autoscaling:trigger|BreachDuration': '5',
  'aws:autoscaling:trigger|EvaluationPeriods': '1',
  'aws:autoscaling:trigger|LowerBreachScaleIncrement': '-1',
  'aws:autoscaling:trigger|LowerThreshold': '2000000',
  'aws:autoscaling:trigger|MeasureName': 'NetworkOut',
  'aws:autoscaling:trigger|Period': '5',
  'aws:autoscaling:trigger|Statistic': 'Average',
  'aws:autoscaling:trigger|Unit': 'Bytes',
  'aws:autoscaling:trigger|UpperBreachScaleIncrement': '1',
  'aws:autoscaling:trigger|UpperThreshold': '6000000',
  'aws:autoscaling:updatepolicy:rollingupdate|RollingUpdateEnabled': 'false',
  'aws:autoscaling:updatepolicy:rollingupdate|RollingUpdateType': 'Time',
  'aws:autoscaling:updatepolicy:rollingupdate|Timeout': 'PT30M',
  'aws:cloudformation:template:parameter|InstancePort': '80',
  'aws:ec2:instances|EnableSpot': 'false',
  'aws:ec2:instances|SpotAllocationStrategy': 'capacity-optimized',
  'aws:ec2:instances|SpotFleetOnDemandBase': '0',
  'aws:ec2:vpc|ELBScheme': 'public',
  'aws:elasticbeanstalk:cloudwatch:logs:health|DeleteOnTerminate': 'false',
  'aws:elasticbeanstalk:cloudwatch:logs:health|HealthStreamingEnabled': 'false',
  'aws:elasticbeanstalk:cloudwatch:logs:health|RetentionInDays': '7',
  'aws:elasticbeanstalk:cloudwatch:logs|DeleteOnTerminate': 'false',
  'aws:elasticbeanstalk:cloudwatch:logs|RetentionInDays': '7',
  'aws:elasticbeanstalk:cloudwatch:logs|StreamLogs': 'false',
  'aws:elasticbeanstalk:command|BatchSize': '100',
  'aws:elasticbeanstalk:command|BatchSizeType': 'Percentage',
  'aws:elasticbeanstalk:command|DeploymentPolicy': 'AllAtOnce',
  'aws:elasticbeanstalk:command|IgnoreHealthCheck': 'false',
  'aws:elasticbeanstalk:command|Timeout': '600',
  'aws:elasticbeanstalk:control|DefaultSSHPort': '22',
  'aws:elasticbeanstalk:control|LaunchTimeout': '0',
  'aws:elasticbeanstalk:control|LaunchType': 'Migration',
  'aws:elasticbeanstalk:control|RollbackLaunchOnFailure': 'false',
  'aws:elasticbeanstalk:environment:proxy|ProxyServer': 'nginx',
  'aws:elasticbeanstalk:environment|LoadBalancerType': 'classic',
  'aws:elasticbeanstalk:environment|ServiceRole': 'AWSServiceRoleForElasticBeanstalk',
  'aws:elasticbeanstalk:healthreporting:system|HealthCheckSuccessThreshold': 'Ok',
  'aws:elasticbeanstalk:healthreporting:system|SystemType': 'enhanced',
  'aws:elasticbeanstalk:hostmanager|LogPublicationControl': 'false',
  'aws:elasticbeanstalk:managedactions:platformupdate|InstanceRefreshEnabled': 'false',
  'aws:elasticbeanstalk:managedactions|ManagedActionsEnabled': 'false',
  'aws:elasticbeanstalk:monitoring|Automatically Terminate Unhealthy Instances': 'true',
  'aws:elasticbeanstalk:sns:topics|Notification Protocol': 'email',
  'aws:elasticbeanstalk:xray|XRayEnabled': 'false',
  'aws:elb:healthcheck|HealthyThreshold': '3',
  'aws:elb:healthcheck|Interval': '10',
  'aws:elb:healthcheck|Target': 'TCP:80',
  'aws:elb:healthcheck|Timeout': '5',
  'aws:elb:healthcheck|UnhealthyThreshold': '5',
  'aws:elb:listener:80|InstancePort': '80',
  'aws:elb:listener:80|InstanceProtocol': 'HTTP',
  'aws:elb:listener:80|ListenerEnabled': 'true',
  'aws:elb:listener:80|ListenerProtocol': 'HTTP',
  'aws:elb:loadbalancer|CrossZone': 'false',
  'aws:elb:loadbalancer|LoadBalancerHTTPPort': '80',
  'aws:elb:loadbalancer|LoadBalancerHTTPSPort': 'OFF',
  'aws:elb:loadbalancer|LoadBalancerPortProtocol': 'HTTP',
  'aws:elb:loadbalancer|LoadBalancerSSLPortProtocol': 'HTTPS',
  'aws:elb:policies|ConnectionDrainingEnabled': 'false',
  'aws:elb:policies|ConnectionDrainingTimeout': '20',
  'aws:elb:policies|ConnectionSettingIdleTimeout': '60',
  'aws:rds:dbinstance|HasCoupledDatabase': 'false',
  // Platform-specific option defaults (observed on non-Docker ConfigurationTemplates). The
  // per-language container namespaces + the Corretto build-tool env vars are stable platform
  // defaults; a change away still surfaces.
  'aws:elasticbeanstalk:container:python|NumProcesses': '1',
  'aws:elasticbeanstalk:container:python|NumThreads': '15',
  'aws:elasticbeanstalk:container:python|WSGIPath': 'application',
  'aws:elasticbeanstalk:application:environment|GRADLE_HOME': '/usr/local/gradle',
  'aws:elasticbeanstalk:application:environment|M2': '/usr/local/apache-maven/bin',
  'aws:elasticbeanstalk:application:environment|M2_HOME': '/usr/local/apache-maven',
  'aws:elasticbeanstalk:container:php:phpini|allow_url_fopen': 'On',
  'aws:elasticbeanstalk:container:php:phpini|display_errors': 'Off',
  'aws:elasticbeanstalk:container:php:phpini|max_execution_time': '60',
  'aws:elasticbeanstalk:container:php:phpini|memory_limit': '256M',
  'aws:elasticbeanstalk:container:php:phpini|zlib.output_compression': 'Off',
};
export const EB_OPTION_DERIVED: Record<string, Record<string, string>> = {
  'aws:autoscaling:asg|MaxSize': { SingleInstance: '1', LoadBalanced: '4' },
  'aws:ec2:instances|SpotFleetOnDemandAboveBasePercentage': {
    SingleInstance: '0',
    LoadBalanced: '70',
  },
};
export const EB_OPTION_VALUE_INDEPENDENT: ReadonlySet<string> = new Set([
  'aws:autoscaling:launchconfiguration|ImageId',
  'aws:autoscaling:launchconfiguration|InstanceType',
  // the environment's own EC2 security group (an awseb-e-… generated name) + the ELB's
  'aws:autoscaling:launchconfiguration|SecurityGroups',
  'aws:elb:loadbalancer|SecurityGroups',
  'aws:cloudformation:template:parameter|AppSource',
  'aws:cloudformation:template:parameter|HooksPkgUrl',
  'aws:cloudformation:template:parameter|InstanceTypeFamily',
  // an aggregate echo of the app EnvironmentVariables (includes per-deploy paths like the
  // Python venv staging dir), so any value is a reflection of the declared env vars, not intent
  'aws:cloudformation:template:parameter|EnvironmentVariables',
  'aws:ec2:instances|InstanceTypes',
  'aws:ec2:instances|SupportedArchitectures',
  // the platform-injected Python venv path carries a random per-deploy staging id
  'aws:elasticbeanstalk:application:environment|PYTHONPATH',
  'aws:elasticbeanstalk:healthreporting:system|ConfigDocument',
  // AWS materializes EnhancedHealthAuthEnabled false on a bare template but true on a live
  // environment — differs by resource kind, so fold value-independent rather than FP one side
  'aws:elasticbeanstalk:healthreporting:system|EnhancedHealthAuthEnabled',
]);
// Classify one live-only EB OptionSettings entry: 'atDefault' when it is at its AWS first-run
// default (value-independent, derived-from-EnvironmentType, or equality-gated constant), else
// 'undeclared' so a change away from the default still surfaces. `envType` is the sibling
// `EnvironmentType` option's value (defaults to LoadBalanced, AWS's default when unset).
export function ebOptionSettingTier(
  namespace: unknown,
  optionName: unknown,
  value: unknown,
  envType: string
): 'atDefault' | 'undeclared' {
  // An unset option: DescribeConfigurationSettings returns many option keys with a null or
  // empty Value (BlockDeviceMappings, VPCId, Notification*, RootVolume*, …). Unset is not
  // drift → fold. A change TO a non-empty value is not '' so it still runs the tables below.
  if (value == null || value === '') return 'atDefault';
  const key = `${String(namespace)}|${String(optionName)}`;
  if (EB_OPTION_VALUE_INDEPENDENT.has(key)) return 'atDefault';
  const derived = EB_OPTION_DERIVED[key];
  if (derived) return derived[envType] === value ? 'atDefault' : 'undeclared';
  if (key in EB_OPTION_DEFAULTS && EB_OPTION_DEFAULTS[key] === value) return 'atDefault';
  return 'undeclared';
}

// Undeclared TOP-LEVEL keys whose AWS-chosen default is NON-DETERMINISTIC — the value
// varies by account / CDK feature-flag / creation date, so a single KNOWN_DEFAULTS value
// cannot fold every valid form (folding one leaves the other as false undeclared drift).
// Folded to `atDefault` REGARDLESS of value: the property is not declared, so any value AWS
// returns is AWS's choice, never user intent (a user who cares DECLARES it, and then it is
// compared in the declared loop and never reaches here).
//   AWS::ECS::Service.AvailabilityZoneRebalancing — reads back "ENABLED" on some services
//   and "DISABLED" on others (both observed live), depending on how/when the service was
//   created; neither is "the" default.
export const VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS: Record<string, ReadonlySet<string>> = {
  //   AWS::ECS::Service.PlatformVersion — a service that declares no platform version reads
  //   back the concrete version AWS provisioned ("1.4.0" today); "use the default/latest" is
  //   satisfied by whatever concrete version is current, so any value is not user intent. (A
  //   DECLARED "LATEST" is handled by LATEST_SENTINEL_PATHS in the declared loop.)
  'AWS::ECS::Service': new Set(['AvailabilityZoneRebalancing', 'PlatformVersion']),
  //   AWS::KinesisAnalyticsV2::Application.ApplicationMaintenanceConfiguration — a Flink
  //   app that declares no maintenance window reads back a service-ASSIGNED window
  //   ({ApplicationMaintenanceWindowStartTime}). The window is not a constant we can pin
  //   (AWS may assign it per app/region — constancy unverified live), so fold it
  //   value-independent: undeclared, so whatever window AWS chose is its default, not user
  //   intent. A DECLARED window goes through the declared loop (compared), unaffected.
  'AWS::KinesisAnalyticsV2::Application': new Set(['ApplicationMaintenanceConfiguration']),
  //   AWS::ElasticBeanstalk::ConfigurationTemplate / ::Environment.PlatformArn — a template
  //   or environment that declares a SolutionStackName (not a PlatformArn) reads back the
  //   platform ARN AWS DERIVED from it ("arn:aws:elasticbeanstalk:<region>::platform/<name>/
  //   <version>"). The two are alternative ways to name the same platform, so the derived
  //   ARN is a pure reflection of the declared SolutionStackName — its value carries the
  //   region and a platform VERSION that moves as AWS republishes, so it is not a constant we
  //   can pin. Fold value-independent: undeclared, so whatever ARN AWS returns is not user
  //   intent (a DECLARED PlatformArn goes through the declared loop, compared). Observed live
  //   on a fresh elasticbeanstalk-rich template + environment (2026-07-07).
  'AWS::ElasticBeanstalk::ConfigurationTemplate': new Set(['PlatformArn']),
  'AWS::ElasticBeanstalk::Environment': new Set(['PlatformArn']),
  //   AWS::ElasticLoadBalancing::LoadBalancer.AvailabilityZones — a VPC classic ELB
  //   declares `Subnets` (AvailabilityZones and Subnets are mutually exclusive), and AWS
  //   reads back the AvailabilityZones it PLACED the ELB in — the AZs of those subnets
  //   (["us-east-1a","us-east-1b"]). The value is a pure reflection of where the declared
  //   subnets live, which is itself an unresolved Fn::Select(Fn::GetAZs), so it cannot be
  //   pinned to a constant nor derived offline. Undeclared → whatever AZs AWS chose are not
  //   user intent; a user who wants specific AZs declares AvailabilityZones instead of
  //   Subnets, which is then compared in the declared loop. Observed live on a fresh
  //   internal CLB (elb-classic-rich, 2026-07-07).
  //   AWS::ElasticLoadBalancing::LoadBalancer.Policies — a CLB with an HTTPS/SSL listener
  //   that declares only a SSLCertificateId (no explicit SSL policy) reads back an
  //   AWS-assigned SSL negotiation policy: `[{PolicyType:"SSLNegotiationPolicyType",
  //   PolicyName:"ELBSecurityPolicy-2016-08", Attributes:[~100 cipher on/off flags]}]`. The
  //   default predefined policy NAME AWS assigns moves over time as AWS publishes newer
  //   security policies, and the huge cipher `Attributes` list is a derived function of the
  //   name that cannot be practically pinned. Undeclared → whatever policy AWS assigned is
  //   its default, not user intent; a user who wants a specific SSL policy declares
  //   `Policies`, which is then compared in the declared loop. Observed live on a fresh
  //   internet-facing CLB with an HTTPS listener (elb-classic-https, 2026-07-07).
  'AWS::ElasticLoadBalancing::LoadBalancer': new Set(['AvailabilityZones', 'Policies']),
  //   AWS::ApiGateway::Authorizer.AuthType — a REST-API authorizer's schema carries NO
  //   `AuthType` property (the template declares `Type`: TOKEN / REQUEST /
  //   COGNITO_USER_POOLS); AWS DERIVES and reads back AuthType from it ("custom" for
  //   TOKEN/REQUEST, "cognito_user_pools" for COGNITO_USER_POOLS). Since AuthType can
  //   never be declared, any value AWS returns is a pure reflection of the declared Type,
  //   not user intent — and a real change to Type surfaces in the declared loop on `Type`
  //   itself. Fold value-independent so both derived forms (and any future enum) fold
  //   without enumerating each. Both observed live first-run (LineLink cognito, my-app
  //   AimAssociation TOKEN "custom") with no out-of-band edit.
  'AWS::ApiGateway::Authorizer': new Set(['AuthType']),
  //   AWS::RDS::DBCluster / ::DBInstance — an Aurora cluster/instance that declares no explicit
  //   KMS key, availability-zone placement, or maintenance/backup window reads back the values
  //   AWS ASSIGNED at creation: a specific `KmsKeyId` (the account/CDK key — create-only, so it
  //   can never drift), the `AvailabilityZone(s)` AWS placed it in (create-only), and a
  //   RANDOMLY-assigned `PreferredMaintenanceWindow` / `PreferredBackupWindow`. None is a
  //   constant we can pin, and none is user intent — a user who cares DECLARES it, and then it
  //   is compared in the declared loop (detected) and never reaches here. Fold value-independent
  //   (mirrors the KinesisAnalytics maintenance-window precedent above). Observed live first-run
  //   on my-app-Rds / my-app-UserStore-DB with no out-of-band edit.
  //   `PerformanceInsightsKmsKeyId` (cluster) / `PerformanceInsightsKMSKeyId` (instance — note
  //   the API's different casing) is the same shape as `KmsKeyId`: a Performance-Insights-
  //   enabled cluster/instance that pins no explicit PI key reads back the AWS-assigned key.
  //   `EngineLifecycleSupport` — the RDS Extended Support enrollment. The value is set by the
  //   resource's ORIGINAL creation era: a lineage first created BEFORE RDS Extended Support
  //   existed (roughly early 2024) reads `open-source-rds-extended-support-disabled` (never
  //   enrolled), while one created after reads the `open-source-rds-extended-support` default.
  //   cdkrd CANNOT reconstruct this from the live model, because a RESTORE (from snapshot / PITR)
  //   resets the readable `ClusterCreateTime` to the restore date while the cluster still carries
  //   its pre-feature lineage's `-disabled`. So an untouched, undeclared cluster can read
  //   `-disabled` under a RECENT creation timestamp — reading `ClusterCreateTime` would
  //   mis-classify it. Live-verified: a 2025-08 restore of a legacy cluster reads `-disabled`
  //   while a 2024-11 fresh create reads `-extended-support` (the date the live model exposes is
  //   uncorrelated with the value). Both forms are AWS's choice, not user intent, so a constant
  //   KNOWN_DEFAULTS cannot fold both without a false positive on one (surfacing an untouched
  //   restored cluster's `-disabled` would be exactly that). Fold value-independent; a user who
  //   cares about the enrollment (its billing / EOL implications) DECLARES it, and it is then
  //   compared in the declared loop (detected).
  'AWS::RDS::DBCluster': new Set([
    'KmsKeyId',
    'PerformanceInsightsKmsKeyId',
    'AvailabilityZones',
    'PreferredMaintenanceWindow',
    'PreferredBackupWindow',
    'EngineLifecycleSupport',
  ]),
  'AWS::RDS::DBInstance': new Set([
    'KmsKeyId',
    'PerformanceInsightsKMSKeyId',
    'AvailabilityZone',
    'PreferredMaintenanceWindow',
    'PreferredBackupWindow',
    'EngineLifecycleSupport',
  ]),
  //   AWS::EKS::AccessEntry.Username — an access entry that declares no explicit Username reads
  //   back the value EKS DERIVES from the declared PrincipalArn
  //   ("arn:aws:sts::<acct>:assumed-role/<role>/{{SessionName}}" for an IAM role). It can never
  //   be a constant we pin (it embeds the per-resource role name), and it is never user intent
  //   when undeclared — a user who sets a custom Username declares it (compared in the declared
  //   loop). Fold value-independent. Observed live first-run (hunt 2026-07-03 round E).
  'AWS::EKS::AccessEntry': new Set(['Username']),
  //   AWS::Glue::Job.MaxCapacity / .AllocatedCapacity — a job that sizes itself with the modern
  //   `WorkerType` + `NumberOfWorkers` pair (a glueetl / gluestreaming job on Glue 2.0+) declares
  //   NEITHER capacity field; AWS DERIVES both from the worker sizing and reads them back
  //   (G.1X × 10 workers → MaxCapacity 10 / AllocatedCapacity 10; G.025X × 2 → MaxCapacity 0.5 /
  //   AllocatedCapacity 0). The two are mutually exclusive with WorkerType/NumberOfWorkers, so
  //   when undeclared they can only be an AWS reflection of the declared sizing, never user intent
  //   — and a real change to the sizing surfaces on `WorkerType` / `NumberOfWorkers` in the
  //   declared loop. `AllocatedCapacity` is additionally a legacy field AWS always echoes. Fold
  //   value-independent so every DPU value folds without a table (a job that instead DECLARES
  //   MaxCapacity — a Python-shell job — goes through the declared loop, compared). Observed live
  //   first-run on my-app-Exporter (five G.1X ETL jobs + one G.025X streaming job), no edit.
  'AWS::Glue::Job': new Set(['MaxCapacity', 'AllocatedCapacity']),
  //   AWS::EC2::SecurityGroupIngress / ::SecurityGroupEgress.SourceSecurityGroupName — a rule that
  //   references its peer group by id (`SourceSecurityGroupId`, the CDK default) declares no
  //   `SourceSecurityGroupName`; AWS DERIVES and reads back the referenced group's NAME
  //   ("my-app-Exporter-Glue-sg") from that id. It can never be a constant we pin (it embeds the
  //   per-group name), and when undeclared it is a pure reflection of the declared
  //   SourceSecurityGroupId, not user intent — a real change to the peer surfaces on
  //   `SourceSecurityGroupId` in the declared loop. Fold value-independent. (A user who references
  //   a peer by name — EC2-Classic style — DECLARES SourceSecurityGroupName, compared.) Observed
  //   live first-run on my-app-Exporter's self-referencing Glue SG ingress, no edit.
  'AWS::EC2::SecurityGroupIngress': new Set(['SourceSecurityGroupName']),
  'AWS::EC2::SecurityGroupEgress': new Set(['SourceSecurityGroupName']),
  //   The RDS-family + cache engines all mirror the RDS precedent above: a cluster/instance
  //   that declares no maintenance / backup / snapshot window reads back a window AWS
  //   RANDOMLY ASSIGNED at creation (e.g. "sat:03:00-sat:04:00", "03:10-03:40"). It is not a
  //   constant we can pin (AWS picks it per resource/region) and never user intent when
  //   undeclared — a user who cares DECLARES it and is then compared in the declared loop.
  //   Fold value-independent, exactly like AWS::RDS::* above. Found by the offline first-run-
  //   noise sweep across the DocDB / Neptune / ElastiCache / MemoryDB / Redshift corpus cases
  //   (undeclared on every one, no out-of-band edit). Equality is irrelevant — any window folds.
  'AWS::DocDB::DBCluster': new Set(['PreferredMaintenanceWindow', 'PreferredBackupWindow']),
  'AWS::DocDB::DBInstance': new Set(['PreferredMaintenanceWindow']),
  'AWS::Neptune::DBCluster': new Set(['PreferredMaintenanceWindow', 'PreferredBackupWindow']),
  //   AWS::Neptune::DBInstance.AvailabilityZone — AWS places an undeclared instance in an AZ it
  //   picks (create-only, so it can never drift; never user intent when undeclared), exactly like
  //   AWS::RDS::DBInstance.AvailabilityZone above. A user who pins a placement DECLARES it and is
  //   then compared in the declared loop.
  'AWS::Neptune::DBInstance': new Set(['PreferredMaintenanceWindow', 'AvailabilityZone']),
  'AWS::ElastiCache::CacheCluster': new Set(['PreferredMaintenanceWindow', 'SnapshotWindow']),
  'AWS::ElastiCache::ReplicationGroup': new Set(['PreferredMaintenanceWindow', 'SnapshotWindow']),
  'AWS::ElastiCache::ServerlessCache': new Set(['DailySnapshotTime']),
  'AWS::MemoryDB::Cluster': new Set(['MaintenanceWindow', 'SnapshotWindow']),
  //   AWS::Redshift::Cluster.AvailabilityZone — AWS places an undeclared cluster in an AZ it picks
  //   (create-only, never user intent when undeclared), exactly like RDS AvailabilityZone above.
  //   OffPeakWindowOptions on an OpenSearch domain is the AWS-ASSIGNED off-peak maintenance window
  //   (an object {OffPeakWindow:{WindowStartTime:{Hours,Minutes}},Enabled}); AWS enables it and
  //   assigns the start time per domain, so fold the whole property value-independent (a domain
  //   that DECLARES an off-peak window is compared in the declared loop).
  //   AWS::Redshift::Cluster.ClusterVersion — a cluster that pins no explicit version reads back
  //   the concrete engine version AWS provisioned ("1.0" today). "use the current default" is
  //   satisfied by whatever version is current, so it is not user intent when undeclared (a user
  //   who cares DECLARES ClusterVersion → compared). Live-verified undeclared on a fresh deploy.
  'AWS::Redshift::Cluster': new Set([
    'PreferredMaintenanceWindow',
    'AvailabilityZone',
    'ClusterVersion',
  ]),
  'AWS::OpenSearchService::Domain': new Set(['OffPeakWindowOptions']),
  //   AWS::AmazonMQ::Broker.MaintenanceWindowStartTime — a broker that declares no window reads
  //   back an AWS-assigned one as an OBJECT ({DayOfWeek, TimeOfDay, TimeZone}); value-independent
  //   folds the whole top-level property whatever its shape, so the assigned window is not first-
  //   run noise (a DECLARED window is compared in the declared loop).
  'AWS::AmazonMQ::Broker': new Set(['MaintenanceWindowStartTime']),
  //   Core VPC-networking types whose undeclared, AWS-ASSIGNED, CREATE-ONLY placement identifiers
  //   read back on every first run. Each is a per-resource value AWS picks at creation from the
  //   surrounding VPC/subnet/region — never a constant we can pin, and never user intent when
  //   undeclared. All are create-only (schema `createOnly`), so a value-independent fold can never
  //   hide a real out-of-band change: the value physically cannot move without replacing the
  //   resource, which is itself a template change surfaced elsewhere. A user who pins a specific
  //   value DECLARES it and is then compared in the declared loop. Found by the offline first-run-
  //   noise sweep across the VPC-common / EC2-instance / EFS / peering corpus cases (undeclared on
  //   every one, no out-of-band edit), each confirmed create-only from its live CFn schema:
  //     * EC2 Instance / NetworkInterface / NatGateway `PrivateIpAddress` — the primary private IP
  //       AWS allocates from the subnet CIDR (e.g. "10.0.0.216"); immutable after launch.
  //     * EFS MountTarget `IpAddress` — the mount-target IP AWS allocates from the subnet.
  //     * EC2 EIP `NetworkBorderGroup` — the address's border group, defaulting to the region.
  //     * EC2 VPCEndpoint `ServiceRegion` — defaults to the endpoint's own region.
  //     * EC2 VPCPeeringConnection `PeerRegion` — defaults to the requester's region.
  //   VPCEndpoint `DnsOptions` is folded here too, but as an AWS-service-assigned whole config
  //   OBJECT (not a create-only identifier): an endpoint that declares no DnsOptions reads back a
  //   default object whose `DnsRecordIpType` VARIES by endpoint type ("service-defined" for a
  //   gateway endpoint, "ipv4" for an interface one), so it cannot be pinned as one equality-
  //   gated constant. When undeclared every sub-key is an AWS service default, never user intent;
  //   a user who configures DNS DECLARES DnsOptions (compared in the declared loop). Mirrors the
  //   OpenSearch `OffPeakWindowOptions` / AmazonMQ `MaintenanceWindowStartTime` object precedents.
  //     * EC2 NatGateway `VpcId` — AWS DERIVES the VPC id from the declared SubnetId and reads
  //       it back (create-only, embeds the per-resource `vpc-…` id, never declared by CDK).
  'AWS::EC2::Instance': new Set(['PrivateIpAddress']),
  'AWS::EC2::NetworkInterface': new Set(['PrivateIpAddress']),
  'AWS::EC2::NatGateway': new Set(['PrivateIpAddress', 'VpcId']),
  'AWS::EFS::MountTarget': new Set(['IpAddress']),
  'AWS::EC2::EIP': new Set(['NetworkBorderGroup']),
  'AWS::EC2::VPCEndpoint': new Set(['ServiceRegion', 'DnsOptions']),
  'AWS::EC2::VPCPeeringConnection': new Set(['PeerRegion']),
  //     * EC2 VPCCidrBlock `Ipv6CidrBlock` + `Ipv6CidrBlockNetworkBorderGroup` — a
  //       dual-stack / secondary-CIDR association that declares `AmazonProvidedIpv6CidrBlock`
  //       (no explicit block) reads back the /56 AWS allocates plus its border group
  //       (defaulting to the region), both AWS-assigned at creation, create-only, and per-VPC
  //       (the block AWS picks differs every deploy). A user who brings their own CIDR DECLARES
  //       `Ipv6CidrBlock` (compared in the declared loop); undeclared, these are AWS's choice,
  //       never user intent. First-run FP on every clean dual-stack VPC (#684, live 2026-07-08);
  //       mirrors EIP `NetworkBorderGroup` / `PrivateIpAddress`.
  'AWS::EC2::VPCCidrBlock': new Set(['Ipv6CidrBlock', 'Ipv6CidrBlockNetworkBorderGroup']),
  //   AWS::Grafana::Workspace.GrafanaVersion — a workspace that pins no explicit version reads
  //   back the concrete Grafana version AWS provisioned ("10.4" today). AWS assigns the current
  //   GA default at creation, and that default moves over time (a fresh deploy next year reads a
  //   newer version), so it is not a constant we can pin and is never user intent when undeclared
  //   — a user who cares about the version DECLARES GrafanaVersion → compared in the declared loop.
  //   Same shape as AWS::Redshift::Cluster.ClusterVersion / AWS::ECS::Service.PlatformVersion
  //   above. Live-verified undeclared on a fresh grafana-rich deploy ("10.4"), no out-of-band edit.
  'AWS::Grafana::Workspace': new Set(['GrafanaVersion']),
  //   AWS::Bedrock::AgentAlias.RoutingConfiguration — an alias that declares no routing reads
  //   back an AWS-assigned pointer to the auto-created agent version ([{"AgentVersion":"1"}]).
  //   The version number moves as the agent is updated/re-prepared, so it is not a constant we
  //   can pin and is not user intent when undeclared (a user who pins a version DECLARES
  //   routingConfiguration → compared in the declared loop). Live, hunt 2026-07-08 (#619).
  'AWS::Bedrock::AgentAlias': new Set(['RoutingConfiguration']),
  //   AWS::AppSync::ApiKey.Expires (UNDECLARED) — a key that declares no expiry reads back
  //   AWS's creation-time + 7 days (rounded down to the hour): creation-time-relative, not a
  //   constant and not derivable from any declared prop. A DECLARED Expires goes through the
  //   declared loop with EPOCH_HOUR_PATHS rounding (unaffected). The existing corpus ApiKey
  //   case DECLARES Expires, which is why this undeclared scenario stayed latent (#615 lesson).
  //   Live, hunt 2026-07-08 (#619).
  'AWS::AppSync::ApiKey': new Set(['Expires']),
  //   AWS::AppConfig::ExtensionAssociation.ExtensionVersionNumber — an association reads back
  //   the bound extension's current version at creation (1 here). Not declared, not a stable
  //   constant (it equals whatever version the referenced extension is at), and not derivable
  //   from the association's own declared props (ExtensionIdentifier is write-only and carries
  //   no version). A per-association AWS-assigned pointer; a user who pins the version DECLARES
  //   it → compared in the declared loop. Live, hunt 2026-07-08 round D (#622).
  'AWS::AppConfig::ExtensionAssociation': new Set(['ExtensionVersionNumber']),
  //   AWS::StepFunctions::StateMachineVersion.StateMachineRevisionId — a version reads back the
  //   AWS-assigned revision pointer ("INITIAL" for a never-updated machine's first version; a
  //   UUID for a version cut from a later revision). It is a per-resource AWS-assigned identifier
  //   the user cannot meaningfully set, and the value legitimately varies (INITIAL vs a UUID), so
  //   neither a constant nor a derivation fits — value-independent. Live, hunt 2026-07-08 (#628).
  'AWS::StepFunctions::StateMachineVersion': new Set(['StateMachineRevisionId']),
  //   AWS::StepFunctions::StateMachineAlias.StateMachineArn — an alias reads back the ARN of the
  //   state machine it belongs to (an AWS-assigned echo derivable from the declared
  //   RoutingConfiguration's version ARN, but an alias is bound to exactly one state machine and
  //   the ARN carries the machine's generated name segment). Not user intent when undeclared —
  //   fold value-independent. Live, hunt 2026-07-08 (#628).
  'AWS::StepFunctions::StateMachineAlias': new Set(['StateMachineArn']),
};

// R142: true when `value` equals a `|`/`:`/`/`-separated SEGMENT of the physical id.
// Folds a GENERATED_PATHS value only when it ECHOES an id AWS minted (an ApiGateway
// Method's CacheNamespace = the parent Resource id, the middle segment of
// `RestApiId|ResourceId|HttpMethod`), leaving a user-set custom value to surface.
export function isPhysicalIdSegment(value: unknown, physicalId: string | undefined): boolean {
  if (typeof value !== 'string' || physicalId === undefined) return false;
  // The whole-id echo (XRay SamplingRule.RuleARN returns the rule's own ARN — the
  // physical id verbatim) is the purest physical-id segment; a split on `:` would
  // otherwise never reassemble a full ARN.
  if (value === physicalId) return true;
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
  // A Logs Transformer's `TransformerConfig` is an EXECUTION PIPELINE: processors run
  // top-to-bottom (a `parseJson` must precede an `addKeys` that reads the parsed fields),
  // and CloudWatch Logs returns them in declared order. Its CFn schema nonetheless marks it
  // `insertionOrder: false` (→ `schema.unorderedObjectArrayPaths`), which would sort it as an
  // unordered set: masking a genuine reorder AND — the #529 bug — skewing a drift finding's
  // array index into the SORTED model while the Cloud Control `UpdateResource` revert patch
  // addresses the RAW live model, so `revert` failed with `noSuchPath //TransformerConfig/0/...`.
  // Pinning it order-significant keeps both compare sides in raw order so the index aligns.
  'AWS::Logs::Transformer': new Set(['TransformerConfig']),
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
    // Deletion protection is off by default on every LB type (ALB/NLB/GWLB). Equality-gated,
    // so a load balancer that enables it still surfaces the non-default "true".
    'deletion_protection.enabled': 'false',
    'client_keep_alive.seconds': '3600',
    'connection_logs.s3.enabled': 'false',
    'health_check_logs.s3.enabled': 'false',
    // ALB idle_timeout default (observed live on a bare ALB that declared no
    // idleTimeout). NLB has no idle_timeout attribute, so no cross-type conflict.
    'idle_timeout.timeout_seconds': '60',
    // ALB cross-zone load balancing is always on and not configurable -> AWS always
    // returns "true". An NLB's / GWLB's default is "false" — the OPPOSITE — so those
    // two override this entry via ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE below (the shared
    // ALB value here previously mis-folded an out-of-band NLB cross_zone ENABLE as
    // atDefault — a real undeclared change `record` then never snapshotted).
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
    // A dualstack ALB reads back this IPv6 IGW-traffic attribute at its "false" default.
    // Observed live on a bare dualstack ALB.
    'ipv6.deny_all_igw_traffic': 'false',
  },
  'AWS::ElasticLoadBalancingV2::Listener': {
    // A listener that declares no attributes reads back AWS's defaults: the mTLS
    // advertise / response-header attributes are all empty (folded by isTrivialEmpty),
    // and the `server` response header is enabled. Observed live.
    'routing.http.response.server.enabled': 'true',
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

// Load-balancer attribute defaults that differ BY LB TYPE (the LoadBalancer `Type`
// property: application | network | gateway; omitted = application). Merged OVER the
// shared ELB_ATTRIBUTE_DEFAULTS entry in classify, keyed by the live Type. cross_zone
// is the one known split: an ALB is always-on ("true"), while an NLB / GWLB defaults
// OFF ("false"). One shared entry could not fold the NLB first-run "false" AND
// mis-folded an out-of-band NLB cross-zone ENABLE ("true" matched the shared ALB
// default → atDefault, so `record` never snapshotted a real undeclared change and a
// later flip could hide). Observed live on a fresh internal NLB (iot-vpces-rich).
export const ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE: Record<string, Record<string, string>> = {
  network: { 'load_balancing.cross_zone.enabled': 'false' },
  gateway: { 'load_balancing.cross_zone.enabled': 'false' },
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
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  // Leaf vs leaf: allow the typed<->string collapse. Inside a JSON string AWS serializes
  // numbers/booleans as quoted strings, so a declared object `{Port: 443, Tls: true}` reads
  // back as `'{"Port":"443","Tls":"true"}'` — after parse the leaves are `443` vs `"443"`,
  // which strict `===` would false-drift the whole JSON-string prop. isStringlyEqualScalar
  // folds only the representation difference; a genuine value change (443 vs 8080) still differs.
  if (!aObj && !bObj) return isStringlyEqualScalar(a, b);
  // One side object/array, the other scalar/null: a genuine structural mismatch.
  if (aObj !== bObj) return false;
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

// Per-type TOP-LEVEL properties the CloudFormation schema types as a JSON STRING
// but which CDK declares (and the live read often returns) as a parsed OBJECT —
// e.g. AWS::Config::ConfigRule `InputParameters`. The provider stores the whole
// property as a single JSON string; Cloud Control surfaces it parsed for reads but
// re-serializes the model to that string on UpdateResource. A sub-path RFC6902
// patch (`/InputParameters/maxAccessKeyAge`) therefore makes Cloud Control rebuild
// the JSON string in a shape the provider rejects (Config: "Blank spaces are not
// acceptable for input parameter") — the revert never converges. So such a property
// must be compared and reverted as a WHOLE UNIT: classify emits one finding at the
// top-level path (folded stringly so a clean `90` vs `"90"` is not drift), and the
// revert writes the whole property as a COMPACT JSON STRING (`JSON.stringify` of the
// declared object), which the provider accepts verbatim. Curated, like the sibling
// per-type tables — add a property here once its sub-path revert is observed to fail.
export const JSON_STRING_PROPS: Record<string, ReadonlySet<string>> = {
  'AWS::Config::ConfigRule': new Set(['InputParameters']),
};

// Per-type JSON-STRING props whose service INJECTS a constant default MEMBER into the
// parsed document that the template never sent — the same "service fills a default" class
// as KNOWN_DEFAULT_PATHS / matchesKnownDefault, except the default lives INSIDE a parsed
// JSON-string value, so those model-path-keyed tables can't reach it. Keyed
// type -> prop -> a partial object of default KEY:VALUE pairs. Before the JSON_STRING_PROPS
// structural compare, these are subtracted from the LIVE parsed side wherever the DECLARED
// side omits the key AND the live value EQUALS the default (equality-gated: a member
// declared with a non-default value still surfaces). If the parsed value is a top-level
// ARRAY the subtraction runs per element; if an OBJECT, at its root.
//   AWS::CE::CostCategory.Rules — the service injects `"Type":"REGULAR"` (the default
//   rule type) into every rule, so a freshly deployed cost category reported permanent
//   declared drift and revert could never converge (#503). A split-charge rule that sets a
//   non-default Type is not omitted on the declared side, so it still compares.
export const JSON_STRING_DEFAULT_FILLS: Record<string, Record<string, Record<string, unknown>>> = {
  'AWS::CE::CostCategory': { Rules: { Type: 'REGULAR' } },
};

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
  // EMR Serverless Application `Type` — the CFn schema enum is UPPERCASE
  // (`SPARK`/`HIVE`) but the EMR Serverless API canonicalizes to mixed case on
  // read (`Spark`/`Hive`), so a case-sensitive compare false-flags declared drift
  // on every check of a freshly deployed application. `Type` is create-only and
  // the two valid values differ beyond case, so case-insensitive equality hides
  // no real drift. Observed live on a fresh misc-0cov-rich deploy.
  'AWS::EMRServerless::Application': new Set(['Type']),
  // RDS lowercases DB instance / cluster identifiers on creation, so a template
  // that declares a mixed-case `DBInstanceIdentifier` (e.g. CDK derives it from the
  // construct id `my-app-UserStore-DB-writer`) reads back all-lowercase
  // (`my-app-userstore-db-writer`) and a case-sensitive compare false-flags declared
  // drift on every check. The lowercasing is unconditional and unenforceable — you
  // can never actually have an uppercase identifier live — so case-insensitive
  // equality hides no revertable drift; a genuine rename still differs beyond case.
  // Observed live on fresh (non-imported) Aurora stacks in ap-northeast-1.
  'AWS::RDS::DBInstance': new Set(['DBInstanceIdentifier']),
  'AWS::RDS::DBCluster': new Set(['DBClusterIdentifier']),
  // DMS Endpoint `EndpointType` — the CFn/CDK value is lowercase (`source` /
  // `target`) but the DMS API echoes it UPPERCASE (`SOURCE` / `TARGET`) on the
  // DescribeEndpoints read (the SDK_OVERRIDES reader), so a case-sensitive compare
  // false-flags declared drift on every check of a freshly deployed endpoint.
  // `EndpointType` is effectively immutable (source<->target can't be flipped out
  // of band) and the two valid values differ beyond case, so case-insensitive
  // equality hides no real drift. Observed live on a fresh DMS Endpoint deploy.
  'AWS::DMS::Endpoint': new Set(['EndpointType']),
  // A WAFv2 LoggingConfiguration's RedactedFields SingleHeader.Name is stored/echoed
  // LOWERCASED (HTTP header names are case-insensitive per RFC 9110), so a template that
  // declares `Authorization` / `Cookie` false-flags declared drift against the live
  // `authorization` / `cookie` on every check. The `*` matches the array index (the path
  // arrives as `RedactedFields.0.SingleHeader.Name`); the lookup normalizes numeric
  // indices to `*`. Two header names that differ beyond case are a genuine change and
  // still surface. Observed live on a fresh WAF logging deploy.
  'AWS::WAFv2::LoggingConfiguration': new Set(['RedactedFields.*.SingleHeader.Name']),
  // A classic ELB listener's Protocol / InstanceProtocol — CDK emits the value LOWERCASE
  // (`http` / `tcp`) in the template, but the ElasticLoadBalancing API canonicalizes it
  // UPPERCASE (`HTTP` / `TCP`) on the live read, so a case-sensitive compare false-flags
  // DECLARED drift on the whole declared Listeners array of every fresh CLB. The `*`
  // matches the array index (the path arrives as `Listeners.0.Protocol`). The valid
  // protocols differ beyond case (HTTP/HTTPS/TCP/SSL), so case-insensitive equality hides
  // no real change. Observed live on a fresh internal CLB (elb-classic-rich, 2026-07-07).
  'AWS::ElasticLoadBalancing::LoadBalancer': new Set([
    'Listeners.*.Protocol',
    'Listeners.*.InstanceProtocol',
  ]),
};
export function isCaseInsensitiveScalarEqual(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// Per-type property paths that hold an RDS engine PARAMETER map (`Parameters`) whose MySQL
// boolean system variables accept ON/OFF, 1/0, and TRUE/FALSE interchangeably. RDS
// canonicalizes a declared "ON"/"OFF" to "1"/"0" on read, so a template that writes
// `slow_query_log: "ON"` false-flags declared drift against the live "1" on every check of a
// MySQL / Aurora-MySQL cluster (observed live on my-app-Rds). Matched on the map's TOP
// path segment; the per-key leaf compare applies isBooleanTokenEquivalent below.
export const BOOLEAN_PARAM_MAP_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::RDS::DBClusterParameterGroup': new Set(['Parameters']),
  'AWS::RDS::DBParameterGroup': new Set(['Parameters']),
};
const BOOL_TRUE_TOKENS = new Set(['on', '1', 'true']);
const BOOL_FALSE_TOKENS = new Set(['off', '0', 'false']);
// True when both values are boolean tokens (on/off, 1/0, true/false — any case) mapping to
// the SAME truthiness. Scoped by the caller to boolean-capable param maps. A non-boolean
// value (a numeric enum "2", a size "128M") is not a token, so it never matches — and a real
// flip (declared "ON" true vs live "0" false) maps to different truthiness, so it still
// surfaces as drift.
export function isBooleanTokenEquivalent(a: unknown, b: unknown): boolean {
  const tok = (v: unknown): 'true' | 'false' | undefined => {
    const s =
      typeof v === 'string'
        ? v.toLowerCase()
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : undefined;
    if (s === undefined) return undefined;
    if (BOOL_TRUE_TOKENS.has(s)) return 'true';
    if (BOOL_FALSE_TOKENS.has(s)) return 'false';
    return undefined;
  };
  const ta = tok(a);
  return ta !== undefined && ta === tok(b);
}

// Per-type property paths that hold a FREE-FORM MAP whose KEYS the Cloud Control read
// handler re-cases (#494). The map-KEY analogue of CASE_INSENSITIVE_PATHS (which folds a
// VALUE case difference). On DataBrew Recipe `Steps[].Action.Parameters` the template AND
// the DataBrew service both carry camelCase keys (`sourceColumn`), but `cloudcontrol
// get-resource` remaps recognized keys onto the PascalCase `RecipeParameters` model
// (`SourceColumn`) — so a case-sensitive diff false-flags DECLARED key drift on every
// check of a freshly deployed recipe and revert can never converge (the re-read gets
// PascalCase again). The drift path is the dotted path from calculateResourceDrift with
// array indices (`Steps.0.Action.Parameters`); the table keys it with `[]` for element
// segments and the lookup normalizes indices before matching. Observed live on hunt
// 2026-07-03 round B.
export const CASE_INSENSITIVE_KEY_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::DataBrew::Recipe': new Set(['Steps[].Action.Parameters']),
};
// True when two objects are equal modulo the ASCII CASE of their keys — the same key set
// case-folded, with EQUAL values per matched key-pair. Equality-gated per key-pair: a real
// key change (an added/removed parameter) or a value change on a matched key still differs,
// so only a pure PascalCase<->camelCase re-casing of an otherwise-identical map folds. Both
// sides must be plain objects (not arrays); a duplicate case-folded key on either side
// (`SourceColumn` + `sourcecolumn`) fails closed (the folded-key sets differ in size).
export function isCaseInsensitiveKeyMapEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  const bLower = new Map<string, unknown>();
  for (const k of bk) bLower.set(k.toLowerCase(), bo[k]);
  if (bLower.size !== bk.length) return false; // duplicate case-folded key on b -> fail closed
  const aLowerSeen = new Set<string>();
  for (const k of ak) {
    const lk = k.toLowerCase();
    if (aLowerSeen.has(lk)) return false; // duplicate case-folded key on a -> fail closed
    aLowerSeen.add(lk);
    if (!bLower.has(lk)) return false;
    if (!deepEqualValue(bLower.get(lk), ao[k])) return false;
  }
  return true;
}
// Minimal structural deep-equal (noise.ts is dependency-free by design — no cross-module
// import). Free-form map values are usually scalars, but a nested object/array value is
// compared structurally so a real value change under a matched key still surfaces.
function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqualValue(ao[k], bo[k]));
}

// A WAFv2 ByteMatchStatement accepts its search pattern as either `SearchString` (the
// plain form CDK emits) or `SearchStringBase64`; the live CC read echoes BOTH back — the
// plain `SearchString` AND its redundant `SearchStringBase64` twin — so a template that
// declares only `SearchString` reports the live-only `SearchStringBase64` as a spurious
// UNDECLARED value on every byte-match rule (nested under a RateBasedStatement's
// ScopeDownStatement it floods the first run). Canonicalize BOTH compare sides to the
// plain `SearchString`: wherever an object carries a `SearchStringBase64`,
//   - if a `SearchString` sibling is present and the base64 IS its faithful echo, drop the
//     redundant twin (the observed CC shape), or
//   - if there is no `SearchString` sibling, decode the base64 to UTF-8 and rename it —
// both gated on a base64 ROUND-TRIP (re-encoding yields the same base64), so a genuinely
// binary pattern, or a mismatched twin, is left untouched and still surfaces. The declared
// side (plain `SearchString`, no base64) is a no-op; the live side is folded to match, so a
// clean rule is not drift while an out-of-band pattern change (both live keys change in
// lockstep) still surfaces via the `SearchString` compare. Applied (via
// canonicalizeForCompare) only for AWS::WAFv2::WebACL. Pure.
export function normalizeWafByteMatchDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeWafByteMatchDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = normalizeWafByteMatchDeep(v);
  const b64 = out.SearchStringBase64;
  if (typeof b64 === 'string') {
    const plain = out.SearchString;
    if (typeof plain === 'string') {
      // Both present: drop the base64 twin when it faithfully echoes the plain string.
      if (Buffer.from(plain, 'utf8').toString('base64') === b64) delete out.SearchStringBase64;
    } else if (!('SearchString' in out)) {
      // base64 only: decode to the plain form the template declares, if it round-trips.
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (Buffer.from(decoded, 'utf8').toString('base64') === b64) {
        delete out.SearchStringBase64;
        out.SearchString = decoded;
      }
    }
  }
  return out;
}

// Per-type OpenSSH public-key paths (EC2 KeyPair `PublicKeyMaterial`). EC2 stores
// only the key MATERIAL: on read it rewrites the free-text comment field to the
// key pair NAME and appends a trailing newline (declared
// `ssh-ed25519 AAAA... me@laptop`, live `ssh-ed25519 AAAA... <KeyName>\n`), so a
// string compare false-flags declared drift on every check of an imported key
// pair. The comment is not part of the key and is unenforceable (AWS always
// overwrites it), so compare only `<type> <base64>`; a genuine key-material
// change still differs. `PublicKeyMaterial` is create-only, so the folded
// comment hides nothing revertable. Observed live on a fresh misc-0cov-rich deploy.
export const SSH_PUBLIC_KEY_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::EC2::KeyPair': new Set(['PublicKeyMaterial']),
};
// True when both values parse as OpenSSH public keys (`<type> <base64> [comment]`)
// with the same type + base64 material. Non-parsing inputs never match, so the
// fold can't fire on an arbitrary string pair.
export function isSshPublicKeyEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const material = (s: string): string | undefined => {
    const parts = s.trim().split(/\s+/);
    const type = parts[0];
    const blob = parts[1];
    if (type === undefined || blob === undefined) return undefined;
    if (!/^(?:sk-)?(?:ssh|ecdsa)-[a-z0-9-]+(?:@[a-z0-9.-]+)?$/.test(type)) return undefined;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return undefined;
    return `${type} ${blob}`;
  };
  const ma = material(a);
  return ma !== undefined && ma === material(b);
}

// Per-type Redis/Valkey ACL access-string paths (ElastiCache / MemoryDB `User.
// AccessString`, read via SDK_SUPPLEMENTS — #482). The service CANONICALIZES the
// string on write: a declared `on ~app:* +@read` reads back `on ~app:* -@all +@read`
// (a `-@all` reset baseline is inserted after the key/channel patterns). A raw string
// compare would false-flag every user on every check, hiding the very drift the
// supplement exists to catch behind an instant FP.
export const ACCESS_STRING_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::ElastiCache::User': new Set(['AccessString']),
  'AWS::MemoryDB::User': new Set(['AccessString']),
};
// True when two ACL strings are equal modulo the service-inserted `-@all` baseline
// term. Redis ACL rules are ORDER-SENSITIVE (later terms override earlier ones), so
// this deliberately does NOT sort or set-compare: the token sequences must match
// exactly once surplus `-@all` tokens on either side are dropped down to the other
// side's count. Dropping `-@all` is safe because it is the ACL's implicit starting
// state (every user starts with no commands granted): re-stating it cannot widen
// access, and a canonicalized live string always re-inserts it — so a genuine
// out-of-band grant (an added `+@write`, a changed key pattern) still differs
// token-for-token.
export function isAccessStringEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const tokens = (s: string): string[] => s.trim().split(/\s+/);
  const ta = tokens(a);
  const tb = tokens(b);
  const surplus = ta.filter((t) => t === '-@all').length - tb.filter((t) => t === '-@all').length;
  const drop = (list: string[], n: number): string[] => {
    if (n <= 0) return list;
    const out: string[] = [];
    let left = n;
    for (const t of list) {
      if (t === '-@all' && left > 0) {
        left--;
        continue;
      }
      out.push(t);
    }
    return out;
  };
  const na = drop(ta, surplus);
  const nb = drop(tb, -surplus);
  return na.length === nb.length && na.every((t, i) => t === nb[i]);
}

// Per-type property paths whose value is a Java `.properties` FILE (key=value lines) that
// AWS accepts as plaintext but stores/echoes with its own formatting — line order, blank
// lines, `#`/`!` comments and trailing newline are all cosmetic. Compared as parsed
// key=value MAPS (order/comment/blank/trailing-newline insensitive) so a clean deploy is
// not drift; a genuine key add/remove/value change still differs. AWS::MSK::Configuration
// `ServerProperties` — the Kafka server.properties blob, supplemented via
// DescribeConfigurationRevision (writeOnly, #508).
export const PROPERTIES_FILE_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::MSK::Configuration': new Set(['ServerProperties']),
};
export function isPropertiesFileEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const parse = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const raw of s.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      m.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return m;
  };
  const ma = parse(a);
  const mb = parse(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
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
  // Route53 canonicalizes record names to FQDN form the same way (CDK L2 emits
  // the trailing dot, but raw-template / L1 users routinely omit it). The
  // override reader's alignTrailingDot already handles Name/DNSName; this entry
  // closes the same class for any non-override read path.
  'AWS::Route53::RecordSet': new Set(['Name']),
  // Route53 Resolver appends the trailing dot to a FORWARD rule's DomainName on
  // read (live-proven: declared "cdkrd-hunt.internal" reads back
  // "cdkrd-hunt.internal.").
  'AWS::Route53Resolver::ResolverRule': new Set(['DomainName']),
};
export function isTrailingDotEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const strip = (s: string): string => (s.endsWith('.') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

// Per-type property paths whose trailing `/` is optional because the service
// NORMALIZES it away on store while the declared/template form keeps it. Sibling of
// TRAILING_DOT_PATHS (Route53 FQDN dots). Live-proven for ECR
// RepositoryCreationTemplate `Prefix`: a template declares `Prefix: "cdkrd-hunt/"`
// (S3-prefix habit — the trailing delimiter is conventional) but the service stores
// `"cdkrd-hunt"`, so after the CC_IDENTIFIER_ADAPTERS read succeeds the residual
// `Prefix` diff is pure trailing-delimiter noise, not drift. A genuine prefix change
// still differs once both sides are stripped.
export const TRAILING_SLASH_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::ECR::RepositoryCreationTemplate': new Set(['Prefix']),
};
export function isTrailingSlashEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const strip = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

// Per-type property paths where the declared `EngineVersion`/version track and the
// live value differ only in PRECISION — one is a major/minor track, the other the
// concrete patch version — so they name the same version and the difference is not
// drift. This happens in BOTH directions:
//   - partial -> concrete (R130: RDS DBInstance declared `"8.0"` reads back `"8.0.45"`;
//     the engine auto-selects the latest patch within the declared track).
//   - concrete -> partial (ElastiCache Memcached CacheCluster declared `"1.6.22"` reads
//     back the major.minor track `"1.6"`; the service stores/echoes the track, not the
//     patch). `isVersionPrefixMatch` is symmetric and folds this too.
// A deliberately narrow rule, NOT a generic string prefix: both sides must be
// dot-separated version strings and the SHORTER must be a leading run of segments of
// the LONGER, so `"8.0"` matches `"8.0.45"` but `"8.0"` never matches `"8.05"` (segment
// boundary) and `"8.1"` never matches `"8.0.45"` (a genuine track change still differs).
// Observed-only entries; the drift path is the dotted path from calculateResourceDrift.
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
  // ElastiCache resolves a partial Redis EngineVersion the same way: a declared
  // `"7.1"` provisions and reads back the concrete `"7.1.0"` (live-proven). The
  // EngineVersion is writeOnly on the RG and supplied by the SDK_SUPPLEMENTS reader
  // (from the member cache cluster), so it must fold the prefix like its DB siblings.
  'AWS::ElastiCache::ReplicationGroup': new Set(['EngineVersion']),
  // Live-observed on a fresh elasticache-memcached deploy: a Memcached CacheCluster
  // declared with a FULL version (`"1.6.22"`) reads back the major.minor TRACK
  // (`"1.6"`) — the CONCRETE->PARTIAL direction (the reverse of the DB-family
  // partial->concrete). Redis CacheCluster echoes its `"7.1"` verbatim (no patch
  // segment), so only the Memcached patch-truncation actually triggers the fold; the
  // symmetric isVersionPrefixMatch covers both. A genuine track change (`"1.5"` vs
  // `"1.6.22"`) still differs.
  'AWS::ElastiCache::CacheCluster': new Set(['EngineVersion']),
  // Amazon MQ resolves a partial EngineVersion the same way (corpus-proven: declared
  // `"5.18"` provisions the concrete `"5.18.7"`, surfaced in the readOnly
  // `EngineVersionCurrent`). Today `EngineVersion` itself is writeOnly -> a readGap, so
  // this entry is a PROACTIVE guard, not an active fold: it fires ONLY if a future
  // SDK_SUPPLEMENTS reader ever projects the concrete `EngineVersion` back (as was done
  // for the ElastiCache RG above), at which point a declared `"5.18"` vs live `"5.18.7"`
  // would otherwise false-drift. Equality-gated + symmetric, so harmless while inert.
  'AWS::AmazonMQ::Broker': new Set(['EngineVersion']),
};
export function isVersionPrefixMatch(declared: unknown, live: unknown): boolean {
  if (typeof declared !== 'string' || typeof live !== 'string') return false;
  if (declared.length === 0 || live.length === 0) return false;
  const dSegs = declared.split('.');
  const lSegs = live.split('.');
  // The two sides differ only in precision: the SHORTER (the track) must be a leading
  // run of segments of the LONGER (the concrete patch version). Symmetric — the track
  // can be on either side (declared partial vs live concrete for the DB family; declared
  // concrete vs live partial for Memcached). Equal length is not a prefix (an exact-equal
  // value isn't drift and never reaches here; an equal-length mismatch is a real change).
  const [shortSegs, longSegs] = dSegs.length <= lSegs.length ? [dSegs, lSegs] : [lSegs, dSegs];
  if (shortSegs.length >= longSegs.length) return false;
  return shortSegs.every((seg, i) => seg === longSegs[i]);
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

// Per-type paths where a declared `"Intelligent-Tiering"` is a REQUEST that AWS
// resolves to the actual tier it provisioned (`"Standard"` or `"Advanced"`,
// live-proven: a >4 KB value reads back "Advanced", a small one "Standard"). The
// resolved tier is therefore not drift against the declared Intelligent-Tiering
// request — but a real Standard↔Advanced change (or a declared concrete tier that
// differs) still surfaces. Only AWS::SSM::Parameter `Tier` today.
export const INTELLIGENT_TIERING_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::SSM::Parameter': new Set(['Tier']),
};
export function isIntelligentTieringMatch(declared: unknown, live: unknown): boolean {
  return declared === 'Intelligent-Tiering' && (live === 'Standard' || live === 'Advanced');
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
// Per-type path patterns for a `[{<name>, <value>}]` pair array that the service
// treats as an IDENTITY-KEYED SET (keyed by the name field) AND default-fills: the
// template declares a SUBSET, the service REORDERS the set and INJECTS its own server
// defaults. The name field is not in IDENTITY_FIELDS, so the whole array false-flags
// as one `declared` drift. Matched against the dotted drift path (which carries the
// parent array index, e.g. `…Processors.0.Parameters`). Cases (both observed live):
//   - Kinesis Firehose processor `Parameters` ({ParameterName,ParameterValue}): a
//     Lambda processor declared [RoleArn, BufferSizeInMBs, BufferIntervalInSeconds,
//     LambdaArn] reads back reordered with a server-injected NumberOfRetries=3
//     (firehose-processors-rich).
//   - RDS OptionGroup `OptionConfigurations[].OptionSettings` ({Name,Value}): RDS
//     materializes EVERY option setting of a configured option (a MariaDB audit
//     plugin declaring 2 settings reads back all 9, some Name-only with no Value) —
//     a whole-array declared FP on every fresh deploy (#480, rds-optiongroup-evsub).
export interface NameValueSubsetSpec {
  re: RegExp;
  nameField: string;
  valueField: string;
}
export const NAME_VALUE_SUBSET_PATHS: Record<string, NameValueSubsetSpec> = {
  'AWS::KinesisFirehose::DeliveryStream': {
    re: /(^|\.)Processors\.\d+\.Parameters$/,
    nameField: 'ParameterName',
    valueField: 'ParameterValue',
  },
  'AWS::RDS::OptionGroup': {
    re: /(^|\.)OptionConfigurations\.\d+\.OptionSettings$/,
    nameField: 'Name',
    valueField: 'Value',
  },
  // RedshiftServerless Workgroup ConfigParameters (#490): once the writeOnly strip is
  // exempted (schema-strip OVERRIDE_READABLE_WRITEONLY), the top-level ConfigParameters the
  // CC read returns is the FULLY resolved default set (~9 entries: datestyle, query_group,
  // max_query_execution_time, enable_user_activity_logging, search_path, require_ssl,
  // use_fips_ssl, auto_mv, + any declared) vs the 1-2 the template declares — the RDS
  // OptionGroup default-fill shape. Fold as a ParameterKey-keyed subset so the service-filled
  // extras land in atDefault/undeclared-noise, while a declared entry that is MISSING live or
  // whose ParameterValue DIFFERS (the #490 FN: enable_case_sensitive_identifier true->false)
  // still surfaces as real declared drift.
  'AWS::RedshiftServerless::Workgroup': {
    re: /(^|\.)ConfigParameters$/,
    nameField: 'ParameterKey',
    valueField: 'ParameterValue',
  },
};
// Align a declared `[{<name>,<value>}]` array to a live one BY the spec's name field.
// Returns the live-only entries (server-injected / out-of-band entries the template
// never declared) when every DECLARED entry is present in live with an equal value
// (declared ⊆ live, reorder-insensitive) — the caller suppresses the false whole-array
// `declared` drift and surfaces the live-only entries as undeclared inventory
// (fail-closed, recorded). Returns null when a declared entry is MISSING from live or
// its value differs (a genuine declared drift the caller must keep), or when either
// side is not a pure name/value pair array (an element carrying any OTHER key would
// escape the value compare, so it disqualifies the fold rather than risk muting it).
export function alignNameValueSubset(
  declared: unknown,
  live: unknown,
  spec: NameValueSubsetSpec
): unknown[] | null {
  if (!Array.isArray(declared) || !Array.isArray(live)) return null;
  const toMap = (arr: unknown[]): Map<string, unknown> | null => {
    const m = new Map<string, unknown>();
    for (const e of arr) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
      const r = e as Record<string, unknown>;
      if (typeof r[spec.nameField] !== 'string') return null;
      if (Object.keys(r).some((k) => k !== spec.nameField && k !== spec.valueField)) return null;
      m.set(r[spec.nameField] as string, r[spec.valueField]);
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
  return live.filter((e) => !dm.has((e as Record<string, unknown>)[spec.nameField] as string));
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
  // Live-observed on a fresh codepipeline-triggers deploy: a V2 pipeline's Git trigger
  // filter lists — the Branches / FilePaths / Tags Includes/Excludes glob sets and the
  // PullRequest Events enum set — are declared in the CFn schema as `uniqueItems: true`
  // arrays WITHOUT `insertionOrder: false`, so the schema-driven `unorderedScalarPaths`
  // fold does NOT cover them. CodePipeline stores them as SETS: an out-of-band reorder of
  // an identical branch/path/tag list (or a console edit that re-canonicalizes them) reads
  // back in a different order, which a positional compare false-drifts (declared `Includes`
  // [release/*, main, develop] vs live [develop, release/*, main]). A genuine glob
  // add/remove still changes the multiset. Keyed with `*` wildcards (Triggers[] and Push[]/
  // PullRequest[] are arrays); the classify lookup normalizes numeric segments to `*`.
  'AWS::CodePipeline::Pipeline': new Set([
    'Triggers.*.GitConfiguration.Push.*.Branches.Includes',
    'Triggers.*.GitConfiguration.Push.*.Branches.Excludes',
    'Triggers.*.GitConfiguration.Push.*.FilePaths.Includes',
    'Triggers.*.GitConfiguration.Push.*.FilePaths.Excludes',
    'Triggers.*.GitConfiguration.Push.*.Tags.Includes',
    'Triggers.*.GitConfiguration.Push.*.Tags.Excludes',
    'Triggers.*.GitConfiguration.PullRequest.*.Branches.Includes',
    'Triggers.*.GitConfiguration.PullRequest.*.Branches.Excludes',
    'Triggers.*.GitConfiguration.PullRequest.*.FilePaths.Includes',
    'Triggers.*.GitConfiguration.PullRequest.*.FilePaths.Excludes',
    'Triggers.*.GitConfiguration.PullRequest.*.Events',
  ]),
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

// A declared COLLECTION (object/array) property absent from the live read is, BY
// DEFAULT, a real `declared` drift — not a readGap. Many AWS services OMIT a
// sub-config entirely once it is empty/removed but RETURN it when set (EC2
// SecurityGroup ingress/egress rules, IAM inline Policies, S3 Cors/Lifecycle/Website/
// OwnershipControls/Metrics/IntelligentTiering/Analytics/…, Lambda Environment). The
// old rule "absent declared key → readGap (informational, never drift)" SILENTLY
// swallowed every such removal (someone deletes the SSH rule / inline policy / S3
// lifecycle / Lambda env in the console → cdkrd reported CLEAN). Live-confirmed that
// S3 omits ALL its sub-configs when empty, so a per-type allowlist was hopelessly
// incomplete; classify therefore DETECTS an absent declared collection by default and
// re-applies the whole property on revert. FP-safe: a populated collection is always
// returned by AWS, so this only fires on a genuine removal — and an empty declared
// collection is exempted (declared `{}`/`[]` vs absent is not drift).
//
// READGAP_COLLECTION_PATHS is the small DENYLIST of the EXCEPTIONS: declared collection
// properties AWS genuinely NEVER returns even when set (a true readGap), so their
// absence must stay informational, not false drift. Derived from a full golden-corpus
// audit (only these few in ~480 cases). A new genuine-readGap collection surfaces as a
// VISIBLE, denylist-able false positive — never a silent false negative.
export const READGAP_COLLECTION_PATHS: Record<string, ReadonlySet<string>> = {
  // `Timeout` ({AttemptDurationSeconds}) — not echoed by Cloud Control's JobDefinition read.
  'AWS::Batch::JobDefinition': new Set(['Timeout']),
  // `NotificationsWithSubscribers` — write-only-style budget notifications, not read back.
  'AWS::Budgets::Budget': new Set(['NotificationsWithSubscribers']),
  // `SSESpecification` — the SSE config is reflected via other readOnly props, not echoed verbatim.
  'AWS::DynamoDB::GlobalTable': new Set(['SSESpecification']),
  'AWS::DynamoDB::Table': new Set(['SSESpecification']),
};

// SCALAR_RETURNED_WHEN_SET is the ALLOWLIST inverse of the collection default in the
// `else if (!(k in live))` branch (#416): a declared SCALAR absent from the live read
// normally stays an informational `readGap` ("AWS may legitimately not echo a scalar"),
// which is the right FP-cautious default — but it means every service with replace-omit
// update semantics has silently clearable declared scalars (a real console/CLI slip that
// `check` then reports CLEAN). For the paths listed here — scalars OBSERVED to be ALWAYS
// returned by the live read when set (provable with a fresh deploy: zero readGap on a
// clean check) — an absent-from-live declared scalar is DECLARED drift (whole-property
// emit; revert re-adds it via a top-level `add`, same shape as the collection case).
// FP-safety mirrors #416 exactly: a wrongly-listed path surfaces as a VISIBLE, removable
// false positive, never a silent FN. Curated per-path; do NOT broaden to whole types.
//   AWS::NetworkFirewall::RuleGroup.Description — live-proven (#507): a fresh deploy
//   returns Description (zero readGap), and `update-rule-group` WITHOUT --description
//   CLEARS it (replace-omit semantics), which was a silent FN.
//   AWS::NetworkFirewall::FirewallPolicy.Description — same service, same update-replace
//   semantics.
export const SCALAR_RETURNED_WHEN_SET: Record<string, ReadonlySet<string>> = {
  'AWS::NetworkFirewall::RuleGroup': new Set(['Description']),
  'AWS::NetworkFirewall::FirewallPolicy': new Set(['Description']),
};

// Declared SCALAR properties AWS does NOT echo faithfully — a write-time authoring hint
// it normalizes to a canonical STORED form on read, so a declared value that differs from
// the normalized read is a spurious `declared` drift, never a real divergence (and it is
// not actionable: you cannot make AWS report the authored form). Stripped from BOTH the
// declared and live model before compare — unlike a readGap (absent from the read), the
// value IS present, just re-normalized. Distinct from writeOnly (schema-driven) because
// AWS DOES return the property; it just returns its own value.
//   AWS::SSM::Document.DocumentFormat — the format of the SUPPLIED content ("YAML"/"TEXT").
//   AWS parses and STORES every Automation/Command document as JSON, so Cloud Control
//   always reads DocumentFormat back as "JSON" regardless of the authored format.
export const READ_NORMALIZED_DECLARED_PATHS: Record<string, ReadonlySet<string>> = {
  'AWS::SSM::Document': new Set(['DocumentFormat']),
};

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
  // (AccessAnalyzer Analyzer `ArchiveRules` — the reorder FP that motivated #459 — is
  // now folded by the schema-driven `SchemaInfo.unorderedObjectArrayPaths` (its schema
  // marks the array insertionOrder:false and RuleName is not an identity field), so it
  // needs no entry here. The entries below predate that fold or lack the schema flag —
  // Cognito UserPoolResourceServer `Scopes` is insertionOrder-ABSENT, proving the flag
  // is under-set and this manual table stays as the SUPPLEMENT, not replaced.)
  // An ApplicationSignals SLO's `BurnRateConfigurations` is a SET of burn-rate windows
  // ({LookBackWindowMinutes: N}) that AWS returns reordered relative to the template
  // (declared [{60}, {360}] reads back [{360}, {60}]), so a positional compare
  // false-flags each window's LookBackWindowMinutes as declared drift on a freshly
  // recorded SLO. The element has no IDENTITY_FIELD (only LookBackWindowMinutes), so the
  // keyed canonicalizer can't align it — sorting both sides by canonical JSON does, and a
  // genuine window add/remove/change still differs.
  'AWS::ApplicationSignals::ServiceLevelObjective': new Set(['BurnRateConfigurations']),
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
  // A WAFv2 LoggingConfiguration's `RedactedFields` is a SET of discriminated-union
  // FieldToMatch objects ({SingleHeader: {Name}}, {Method: {}}, {QueryString: {}}, …)
  // that WAF echoes SORTED by the discriminator key, not in template order (declared
  // [SingleHeader, Method, QueryString] reads back [Method, QueryString, SingleHeader]),
  // so a positional compare false-flags every shifted field as declared drift on a
  // freshly recorded LoggingConfiguration. The elements carry NO top-level identity
  // field (the discriminator IS the single object key, not one of canonicalizeTagListsDeep's
  // IDENTITY_FIELDS Key/Id/AttributeName/IndexName/Name), so that keyed canonicalizer can't
  // align them — hence the per-type opt-in. Sorting both sides by canonical JSON aligns
  // equal fields; a genuine redacted-field add/remove still differs. Observed live on a
  // fresh wafv2-logging-rich deploy. (The sibling `LoggingFilter.Filters[].Conditions`
  // set was tested in the SAME deploy with two conditions and WAF PRESERVED their order,
  // so it is NOT folded — observed-only.)
  'AWS::WAFv2::LoggingConfiguration': new Set(['RedactedFields']),
  // An EC2 managed prefix list's `Entries` is a SET of {Cidr, Description} route
  // entries. AWS stores them as a set, not an ordered list: after any out-of-band
  // `ModifyManagedPrefixList` (the console/API "someone edited it" path this tool
  // exists to catch) the live entries come back REORDERED relative to the template
  // (declared [10.0.0.0/16, 10.1.0.0/16, 192.168.0.0/24] read back
  // [192.168.0.0/24, 10.1.0.0/16, 10.0.0.0/16]), so a positional compare
  // false-flags every shifted entry's Cidr AND Description as declared drift and
  // MISATTRIBUTES a single real change (one entry's Description edited) as several
  // positional diffs. The element key `Cidr` is NOT one of canonicalizeTagListsDeep's
  // IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so that keyed canonicalizer
  // can't align it — hence the per-type opt-in. Sorting both sides by canonical JSON
  // aligns equal entries by Cidr (the first sorted key); a genuine entry
  // add/remove/description-change still differs. Observed live on a fresh
  // ec2-prefixlist-rich deploy whose entries were reordered by an out-of-band modify.
  'AWS::EC2::PrefixList': new Set(['Entries']),
};

// The IDENTITY field of an UNORDERED_OBJECT_ARRAY_PROPS element, when it HAS one (the
// discriminated-union sets — WAFv2 RedactedFields, ApplicationSignals BurnRateConfigurations
// — do NOT, so they are absent). sortUnorderedObjectArray keys on this field FIRST, so a
// change to a NON-identity sibling field keeps the element in the SAME aligned slot on both
// sides. WITHOUT it, a plain canonical-JSON sort misaligns whenever the changed field sorts
// alphabetically BEFORE the identity in the element's keys — Cognito Scope `ScopeDescription`
// < `ScopeName`, Secret replica `KmsKeyId` < `Region`, ElastiCache `LogFormat`/`LogType`, ASG
// hook `DefaultResult` < `LifecycleHookName` — so editing that field false-flags the UNCHANGED
// identity as drift too (a positional-diff FP, live-observed reverting a Cognito Scope's
// description). Types whose identity ALREADY sorts first (PrefixList `Cidr`, Redshift
// `ParameterName`, ELBv2 ListenerRule `Field`, IAM `PolicyName`) are listed too for robustness
// — keying on the identity is correct regardless of alphabetical luck.
export const UNORDERED_OBJECT_ARRAY_IDENTITY: Record<string, Record<string, string>> = {
  'AWS::Cognito::UserPoolResourceServer': { Scopes: 'ScopeName' },
  'AWS::SecretsManager::Secret': { ReplicaRegions: 'Region' },
  'AWS::ElastiCache::CacheCluster': { LogDeliveryConfigurations: 'LogType' },
  'AWS::ElastiCache::ReplicationGroup': { LogDeliveryConfigurations: 'LogType' },
  'AWS::AutoScaling::AutoScalingGroup': { LifecycleHookSpecificationList: 'LifecycleHookName' },
  'AWS::Redshift::ClusterParameterGroup': { Parameters: 'ParameterName' },
  'AWS::ElasticLoadBalancingV2::ListenerRule': { Conditions: 'Field' },
  'AWS::EC2::PrefixList': { Entries: 'Cidr' },
  'AWS::IAM::Role': { Policies: 'PolicyName' },
  'AWS::IAM::User': { Policies: 'PolicyName' },
  'AWS::IAM::Group': { Policies: 'PolicyName' },
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
  // A CloudFront cache policy's forwarded-header set
  // (`...HeadersConfig.Headers`) is order-insensitive — CloudFront echoes it in its
  // own canonical order, not template order (declared [Origin, A, B] reads back
  // [Origin, B, A]), so a positional compare false-flags the identical header set as
  // declared drift on a freshly recorded policy. A nested SCALAR set (plain header
  // names — not id/ARN-shaped, so canonicalizeIdArraysDeep leaves it);
  // sortNestedObjectArrays sorts scalar arrays by canonical JSON, so equal sets align
  // and a genuine header add/remove/change still differs.
  'AWS::CloudFront::CachePolicy': new Set([
    'CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers',
  ]),
  // A CloudFront distribution's `Aliases` (the CNAME set) is order-insensitive —
  // CloudFront returns it reordered relative to the template (declared [apex, wildcard]
  // reads back [wildcard, apex]), so a positional compare false-flags the identical
  // alias set as declared drift. Same nested-scalar-set treatment as CachePolicy Headers.
  'AWS::CloudFront::Distribution': new Set(['DistributionConfig.Aliases']),
  // An IoT ThingType's `ThingTypeProperties.SearchableAttributes` is a nested SCALAR set
  // (attribute names) that IoT stores as a set and returns in its OWN sorted order —
  // declared ["serial","model"] reads back ["model","serial"], so a positional compare
  // false-flags the identical set as a DECLARED drift on a freshly deployed stack. Because
  // it is declared-tier it SURVIVES `record` (record snapshots only the undeclared
  // dimension) and makes `revert` loop forever (the service re-sorts after every write), so
  // `check --fail` stays red on a clean stack (#623). NOTE the CFn resource schema annotates
  // this array `insertionOrder: true` (+ `uniqueItems: true`), so the schema-driven fold
  // deliberately does NOT engage — but the live service reorders anyway: the classic
  // "schema claims ordered, service re-sorts" case this curated allowlist exists for.
  // sortNestedObjectArrays sorts scalar arrays by canonical JSON, so equal sets align and a
  // genuine attribute add/remove still differs. Live-proven (hunt 2026-07-08 round E).
  'AWS::IoT::ThingType': new Set(['ThingTypeProperties.SearchableAttributes']),
  // RULE-OUT (observed-only, NOT folded): a WAFv2 RuleGroup/WebACL rate-based rule's
  // `Rules[].Statement.RateBasedStatement.CustomKeys` is a SET of discriminated-union
  // aggregate-key objects ({UriPath:{}}, {Header:{Name,…}}, {HTTPMethod:{}}, …) with
  // no top-level IDENTITY_FIELD — the same shape that produced reorder FPs for
  // LoggingConfiguration RedactedFields (#433) and Lambda ESM KafkaBootstrapServers
  // (#437). Fresh wafv2-ratecustomkeys (RuleGroup) AND wafv2-webacl-customkeys (WebACL)
  // deploys each declaring 5 keys in NON-sorted discriminator order ([UriPath, Header,
  // HTTPMethod, Cookie, QueryArgument]) read them back in the EXACT declared order on
  // BOTH host types — WAF PRESERVES CustomKeys order (like AndStatement.Statements and
  // LoggingFilter.Conditions), so there is no FP to fold. Pinned by both fixtures +
  // corpus cases (issue #440).
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
  // A self-managed Apache Kafka event source's `SelfManagedEventSource.Endpoints.
  // KafkaBootstrapServers` is a SET of `host:port` broker strings that Lambda echoes
  // REORDERED, not in template order (declared [b-1…:9092, b-2…:9092] reads back
  // [b-2…:9092, b-1…:9092]), so a positional compare false-flags the identical
  // bootstrap-server set as declared drift on a freshly recorded ESM. The brokers are a
  // SET (a Kafka client connects to ANY one to discover the rest — order carries no
  // meaning), and the `host:port` strings aren't id/ARN/HTTP/AZ-shaped so
  // canonicalizeIdArraysDeep leaves them; this nested scalar path folds them. A genuine
  // broker add/remove still changes the multiset. Observed live on a fresh
  // esm-sourceaccess-rich deploy. (The sibling `SourceAccessConfigurations` set — the
  // {Type, URI} VPC/SASL entries — was tested in the SAME deploy with a deliberately
  // non-sorted list and Lambda PRESERVED its order, so it is NOT folded — observed-only.)
  'AWS::Lambda::EventSourceMapping': new Set([
    'SelfManagedEventSource.Endpoints.KafkaBootstrapServers',
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
export function sortUnorderedObjectArray(v: unknown, identityField?: string): unknown {
  if (!Array.isArray(v)) return v;
  // Sort key = the element's IDENTITY field (when the type declares one via
  // UNORDERED_OBJECT_ARRAY_IDENTITY) FOLLOWED BY the full canonical JSON. Keying on the
  // identity FIRST keeps an element in the SAME aligned slot on both sides when only a
  // NON-identity field changes — otherwise, if that mutable field sorts alphabetically
  // BEFORE the identity in the element's keys (Cognito Scope `ScopeDescription` < `ScopeName`,
  // Secret replica `KmsKeyId` < `Region`, ElastiCache `LogFormat` < `LogType`, ASG hook
  // `DefaultResult` < `LifecycleHookName`), a plain canonical-JSON sort moves the changed
  // element to a different position and the positional diff MISALIGNS, false-flagging the
  // unchanged identity as drift too. The canonical JSON stays as the tiebreaker so equal
  // identities (and identity-less elements) keep the previous deterministic order.
  const keyOf = (e: unknown): string => {
    const id =
      identityField && e !== null && typeof e === 'object' && !Array.isArray(e)
        ? (e as Record<string, unknown>)[identityField]
        : undefined;
    return `${id === undefined ? '' : `${String(id)} `}${canonicalJson(e)}`;
  };
  return [...v].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
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
// which otherwise phantom-drifts on every revert (R46).
//
// Arrays: a length-0 array is trivially empty. A NON-empty array is trivially empty
// ONLY when EVERY element is an OBJECT that is itself trivially empty — the signature
// shape of schema-strip RESIDUE, where an echo attribute's leaves are readOnly-stripped
// leaving `[{}, {}]` husks (RedshiftServerless Workgroup Endpoint
// `VpcEndpoints[].NetworkInterfaces[{},{}]`, #491). This objects-ONLY recursion keeps the
// conservative `[false]` stance for SCALAR arrays (a `[false]`/`[0]`/`[""]` list may be a
// meaningful value, so a scalar-bearing array is never trivially empty), same as the
// top-level scalars (0 stays meaningful, false does not).
export function isTrivialEmpty(v: unknown): boolean {
  if (v === false || v === '') return true;
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    // Objects-only recursion: [{}, {}] husks fold, but any scalar element keeps the array.
    return v.every((el) => el !== null && typeof el === 'object' && isTrivialEmpty(el));
  }
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

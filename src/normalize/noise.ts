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
  'AWS::Events::Rule': { EventBusName: 'default' },
  'AWS::Athena::WorkGroup': { State: 'ENABLED' },
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
    FifoThroughputLimit: 'perQueue', // FIFO queues only
    DeduplicationScope: 'queue', // FIFO queues only
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
  },
  'AWS::EC2::Subnet': {
    PrivateDnsNameOptionsOnLaunch: {
      EnableResourceNameDnsARecord: false,
      HostnameType: 'ip-name',
      EnableResourceNameDnsAAAARecord: false,
    },
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
  },
  'AWS::Cognito::UserPoolClient': {
    EnableTokenRevocation: true,
    AuthSessionValidity: 3,
  },
  'AWS::ECS::Service': {
    SchedulingStrategy: 'REPLICA',
  },
  'AWS::AppSync::GraphQLApi': {
    ApiType: 'GRAPHQL',
    Visibility: 'GLOBAL',
    IntrospectionConfig: 'ENABLED',
  },
  'AWS::KMS::Key': {
    Enabled: true,
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
  },
  'AWS::Cognito::UserPool': {
    'AdminCreateUserConfig.UnusedAccountValidityDays': 7,
    'Policies.SignInPolicy': { AllowedFirstAuthFactors: ['PASSWORD'] },
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
    // ALB cross-zone load balancing is always on and not configurable -> AWS always
    // returns "true"; an NLB's default "false" never matches, so it stays undeclared.
    'load_balancing.cross_zone.enabled': 'true',
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

// AWS resource-id / ARN lists (SubnetIds, SecurityGroupIds, AvailabilityZones,
// VPCSecurityGroups, ...) are UNORDERED sets too, but unlike tags their elements
// are bare scalars, so the tag canonicalizer doesn't touch them and a positional
// diff reports false drift whenever CDK's order != AWS's. Sort only arrays whose
// EVERY element is an AWS resource id (`subnet-0ab…`, `sg-…`, `vpc-…`) or an ARN —
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
      (mapped.every(isIdLike) || mapped.every(isHttpMethod))
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
  // ListenerRule `Conditions` is a SET keyed by Field (path-pattern / host-header /
  // http-header / …) that AWS returns REORDERED relative to the template, so a
  // positional compare false-flags every condition. Sorting both sides by canonical
  // JSON aligns them by Field (the first sorted key), and a genuine condition change
  // still differs. (`Actions` is NOT listed — its element Order is semantic.) The live
  // model also adds a legacy top-level `Values` mirror to each condition; that is
  // handled separately as undeclared nested inventory (subset descent walks only the
  // declared *Config keys). Observed live on a fresh elbv2-listenerrule-rich deploy.
  'AWS::ElasticLoadBalancingV2::ListenerRule': new Set(['Conditions']),
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
  'AWS::ECS::TaskDefinition': new Set([
    'ContainerDefinitions.PortMappings',
    'ContainerDefinitions.VolumesFrom',
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
  'AWS::ElasticLoadBalancingV2::ListenerRule': new Set(['Conditions.PathPatternConfig.Values']),
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

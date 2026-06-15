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
  // R105 (second dogfood-audit wave): more top-level constant service defaults
  // (same exclusions as R104 — no names/ids/ARNs, no region-/account-specific
  // values, no large/evolving config blobs like Athena WorkGroupConfiguration).
  'AWS::ApiGatewayV2::Api': {
    RouteSelectionExpression: '$request.method $request.path',
  },
  'AWS::ApiGatewayV2::Integration': {
    ConnectionType: 'INTERNET',
    TimeoutInMillis: 30000,
  },
  'AWS::CodeBuild::Project': {
    TimeoutInMinutes: 60,
    QueuedTimeoutInMinutes: 480,
  },
  'AWS::DynamoDB::Table': {
    BillingMode: 'PROVISIONED',
  },
  'AWS::ECR::Repository': {
    EncryptionConfiguration: { EncryptionType: 'AES256' },
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
// template and falls through to a real `undeclared` finding. Never recorded by accept.
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
const IDENTITY_FIELDS = ['Key', 'Id', 'AttributeName', 'IndexName'] as const;
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
export function canonicalizeTagListsDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeTagListsDeep);
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
      out[k] = canonicalizeTagListsDeep(val);
    return out;
  }
  return v;
}

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
};
export function isCaseInsensitiveScalarEqual(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
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
// is closed and order-insensitive wherever AWS accepts it, so an array whose EVERY
// element is one of these verbs is safe to sort. (Same content-based philosophy as
// isIdLike: no per-type table, just a value-shape test.)
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const isHttpMethod = (s: unknown): boolean => typeof s === 'string' && HTTP_METHODS.has(s);

export function canonicalizeIdArraysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeIdArraysDeep);
    if (mapped.length > 1 && (mapped.every(isIdLike) || mapped.every(isHttpMethod)))
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
  ]),
  // R84 (observed live on a fresh harvest6 deploy): WAFv2 stores the IP address
  // set and echoes it in its own canonical order, so a fresh deploy reports the
  // declared CIDR list as drift with identical elements in a different order.
  'AWS::WAFv2::IPSet': new Set(['Addresses']),
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
};

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
// KNOWN LIMITATION (R23): this runs in classify's declared loop on LEAF drift records
// only. The drift-calculator reports a scalar-array mismatch as ONE parent-path record
// (value = the whole array), so element-wise stringly comparison never happens — a
// typed `[80, 443]` vs live `["80", "443"]` still reports drift. The direction is a
// false POSITIVE (noise), never hidden drift, so it is fail-safe; collapsing it would
// need a drift-calculator change. Revisit only if a real fixture hits it.
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

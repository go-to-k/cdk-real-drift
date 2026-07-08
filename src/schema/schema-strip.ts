// Fetch a CloudFormation resource schema via describe-type and derive the
// readOnly / writeOnly / default sets used for noise suppression — both as
// top-level name sets (fast checks) and as full dotted paths (nested strip).
import { type CloudFormationClient, DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import type { SchemaInfo } from '../types.js';

const cache = new Map<string, SchemaInfo>();
const EMPTY: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
  unorderedScalarPaths: [],
  unorderedObjectArrayPaths: [],
  freeFormMapPaths: [],
};

export async function getSchemaInfo(
  client: CloudFormationClient,
  resourceType: string
): Promise<SchemaInfo> {
  const cached = cache.get(resourceType);
  if (cached) return cached;
  const info = await fetch(client, resourceType);
  cache.set(resourceType, info);
  return info;
}

// Top-level writeOnly properties that an SDK_OVERRIDES reader (read/overrides.ts) CAN
// actually read back, so they must NOT be writeOnly-stripped / readGap'd for these types
// — the override populates them and they should be compared like any readable property.
// Kept in sync with SDK_OVERRIDES: AWS::EC2::LaunchTemplate `LaunchTemplateData` is
// writeOnly in the registry schema (CC returns only ids/versions), but readEc2LaunchTemplate
// reads the default version's data via DescribeLaunchTemplateVersions. (VersionDescription
// and the top-level TagSpecifications stay writeOnly — the override does not project them.)
export const OVERRIDE_READABLE_WRITEONLY: Record<string, readonly string[]> = {
  'AWS::EC2::LaunchTemplate': ['LaunchTemplateData'],
  // AWS::ElasticBeanstalk::Environment `OptionSettings` is writeOnly (CC never echoes the
  // environment configuration), but the SDK_SUPPLEMENTS reader fetches the full resolved set
  // via elasticbeanstalk:DescribeConfigurationSettings — so compare it (the composite-key
  // subset folds the service-filled extras), not readGap.
  'AWS::ElasticBeanstalk::Environment': ['OptionSettings'],
  // AWS::MSK::Configuration `ServerProperties` is writeOnly (CC never echoes the
  // server.properties blob); the SDK_SUPPLEMENTS reader fetches the latest revision's
  // decoded properties via kafka:DescribeConfigurationRevision, so compare it (through
  // isPropertiesFileEqual — PROPERTIES_FILE_PATHS), not readGap.
  'AWS::MSK::Configuration': ['ServerProperties'],
  // CognitoEvents is writeOnly in the registry schema (CC GetResource never returns it),
  // but readCognitoIdentityPool projects it from the cognito-sync API, so compare it.
  // PushSync / CognitoStreams stay writeOnly readGaps (the override does not project them).
  'AWS::Cognito::IdentityPool': ['CognitoEvents'],
  // AWS::SSM::Parameter `Description`/`AllowedPattern`/`Tier` are writeOnly (CC never
  // echoes them), but the SDK_SUPPLEMENTS reader fetches them via ssm:DescribeParameters
  // — so they must NOT be writeOnly-stripped/readGap'd, they should be compared like any
  // readable prop. Tier folds the undeclared "Standard" default (KNOWN_DEFAULTS) and the
  // declared "Intelligent-Tiering"→Standard/Advanced resolution (INTELLIGENT_TIERING_PATHS).
  // (Policies stays writeOnly: the supplement does not project it — its read shape with a
  // runtime PolicyStatus differs from the CFn JSON-string input.)
  'AWS::SSM::Parameter': ['Description', 'AllowedPattern', 'Tier'],
  // AWS::ElastiCache::ReplicationGroup PreferredMaintenanceWindow / NotificationTopicArn
  // / EngineVersion are writeOnly on the RG (CC never echoes them); the SDK_SUPPLEMENTS
  // reader fetches them VERBATIM from the member cache cluster, so compare, not readGap.
  'AWS::ElastiCache::ReplicationGroup': [
    'PreferredMaintenanceWindow',
    'NotificationTopicArn',
    'EngineVersion',
  ],
  // AWS::ECS::Service `ServiceConnectConfiguration` / `VolumeConfigurations` are writeOnly
  // (CC never echoes them — they live on the service's deployments); the SDK_SUPPLEMENTS
  // reader reconstructs both from the PRIMARY deployment, so compare them, don't readGap.
  'AWS::ECS::Service': ['ServiceConnectConfiguration', 'VolumeConfigurations'],
  // AWS::ElastiCache::User / AWS::MemoryDB::User `AccessString` (the Redis/Valkey ACL)
  // is writeOnly in both schemas, so an out-of-band ACL grant was silently invisible
  // (#482 — a security-relevant FN); the SDK_SUPPLEMENTS readers fetch it via each
  // service's DescribeUsers, so compare it (through isAccessStringEqual — the service
  // canonicalizes the string on write), don't readGap. AuthenticationMode/Passwords/
  // NoPasswordRequired stay writeOnly readGaps (read shape differs from CFn input).
  'AWS::ElastiCache::User': ['AccessString'],
  'AWS::MemoryDB::User': ['AccessString'],
  // AWS::MemoryDB::ParameterGroup `Parameters` is writeOnly (CC never echoes the parameter
  // map), so a declared parameter was an unverifiable readGap — and because the MemoryDB CFn
  // provider does not apply declared Parameters on CREATE, the divergence was doubly invisible.
  // The SDK_SUPPLEMENTS reader fetches the live parameters via memorydb:DescribeParameters and
  // folds the undeclared family-default fill by diffing the managed default.<family> group, so
  // compare it, don't readGap.
  'AWS::MemoryDB::ParameterGroup': ['Parameters'],
  // AWS::RedshiftServerless::Workgroup ConfigParameters / SecurityGroupIds / SubnetIds
  // are writeOnly in the registry schema, so cdkrd filed them under the write-only readGap
  // bucket and an out-of-band change was silently invisible (#490 — a security-relevant FN
  // for an out-of-band SecurityGroupIds swap; live-proven on a ConfigParameters flip). But
  // UNLIKE the entries above, no SDK override is needed: the Cloud Control read ALREADY
  // returns all three at the TOP LEVEL of the same GetResource response cdkrd has (not just
  // inside the read-only `Workgroup` echo attribute), so exempting the writeOnly strip makes
  // cdkrd compare the value it already holds — no extra API call. ConfigParameters meets the
  // default-fill shape (declared 1, live echoes the full ~9-element default set), so it is
  // folded as a ParameterKey-keyed subset via NAME_VALUE_SUBSET_PATHS (noise.ts);
  // SecurityGroupIds / SubnetIds are id-like sets folded for reorder by canonicalizeIdArraysDeep.
  'AWS::RedshiftServerless::Workgroup': ['ConfigParameters', 'SecurityGroupIds', 'SubnetIds'],
  // AWS::Lex::Bot `BotLocales` (the entire conversational model — intents, utterances,
  // slots, slot types, prompts) is writeOnly in the registry schema, so Cloud Control
  // never echoes it and an out-of-band console edit to the model was a silent FN (#527).
  // The SDK_SUPPLEMENTS reader RECONSTRUCTS it from the lexv2-models API tree walk, so
  // compare it, don't readGap. The other writeOnly Bot props (AutoBuildBotLocales,
  // BotFileS3Location, Replication, TestBotAliasSettings, TestBotAliasTags) stay
  // writeOnly readGaps — the supplement does not project them.
  'AWS::Lex::Bot': ['BotLocales'],
};

// Curated readOnly SUPPLEMENTS: JSON-pointer property paths a type's CloudFormation
// schema FORGETS to mark `readOnly`, so the readOnly strip leaves them in the live model
// and they surface as first-run Potential Drift. This is the MIRROR of SDK_SUPPLEMENTS
// (which patches writeOnly gaps the other direction, #482): here we patch a readOnly gap.
// Applied on top of the fetched schema's readOnlyProperties BEFORE the strip runs, so the
// property is stripped for EVERY tier (first-run noise, baseline, revert planning) — the
// right treatment for a lifecycle/status attribute that can never be user intent and flaps
// between values (so an equality-gated KNOWN_DEFAULTS fold would be wrong).
//
// AWS::NetworkManager::GlobalNetwork forgets readOnly on its lifecycle `State`
// (AVAILABLE/UPDATING/DELETING) and `CreatedAt` timestamp — provably an AWS oversight:
// the sibling AWS::NetworkManager::Site marks the SAME pair readOnly
// (readOnlyProperties = [SiteId, SiteArn, State, CreatedAt]). GlobalNetwork's schema has
// readOnly = [Id, Arn] only (#495). Keep this table CURATED/minimal — the corpus scan
// found no other currently-leaking type, so do NOT add speculative entries.
export const SCHEMA_READONLY_SUPPLEMENTS: Record<string, readonly string[]> = {
  'AWS::NetworkManager::GlobalNetwork': ['/properties/State', '/properties/CreatedAt'],
};

// Merge a type's readOnly supplement paths into readOnly (top-level set) + readOnlyPaths
// (nested strip), so the schema-strip layer removes them exactly as if the registry schema
// had listed them in readOnlyProperties. Exported for unit testing without an AWS call.
export function supplementReadOnly(info: SchemaInfo, resourceType: string): SchemaInfo {
  const supplements = SCHEMA_READONLY_SUPPLEMENTS[resourceType];
  if (!supplements?.length) return info;
  const dotted = supplements.map(pointerToDotted);
  const readOnlyPaths = [...new Set([...info.readOnlyPaths, ...dotted])];
  return {
    ...info,
    readOnly: new Set([...info.readOnly, ...dotted.filter((p) => !p.includes('.'))]),
    readOnlyPaths,
  };
}

// The MIRROR of OVERRIDE_READABLE_WRITEONLY: nested paths an SDK_OVERRIDES reader
// CANNOT read back even though the registry schema does not mark them writeOnly —
// the type's Describe API simply never returns them. Appended to `writeOnlyPaths`
// so BOTH sides strip the path (readGap semantics): without this, a declared value
// at such a path false-flags as declared drift against the reader's live model
// (found live on AnomalyDetector: DescribeAnomalyDetectors never echoes a metric-math
// query's cosmetic `Label`, so a declared label reported `desired="…" actual=undefined`).
export const SDK_READER_GAP_PATHS: Record<string, readonly string[]> = {
  'AWS::CloudWatch::AnomalyDetector': ['MetricMathAnomalyDetector.MetricDataQueries.*.Label'],
};

// Append a type's SDK-reader gap paths to writeOnlyPaths (strip from both sides).
// Exported for unit testing without an AWS call.
export function injectReaderGaps(info: SchemaInfo, resourceType: string): SchemaInfo {
  const gaps = SDK_READER_GAP_PATHS[resourceType];
  if (!gaps?.length) return info;
  return { ...info, writeOnlyPaths: [...info.writeOnlyPaths, ...gaps] };
}

// Remove the override-readable writeOnly props from a type's writeOnly sets so the
// classify pipeline compares (not strips/readGaps) the value the override now supplies.
// Exported for unit testing without an AWS call.
export function exemptOverrideReadable(info: SchemaInfo, resourceType: string): SchemaInfo {
  const exempt = OVERRIDE_READABLE_WRITEONLY[resourceType];
  if (!exempt?.length) return info;
  const isExempt = (p: string): boolean => exempt.some((e) => p === e || p.startsWith(`${e}.`));
  return {
    ...info,
    writeOnly: new Set([...info.writeOnly].filter((k) => !exempt.includes(k))),
    writeOnlyPaths: info.writeOnlyPaths.filter((p) => !isExempt(p)),
  };
}

async function fetch(client: CloudFormationClient, resourceType: string): Promise<SchemaInfo> {
  try {
    const r = await client.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );
    return injectReaderGaps(
      exemptOverrideReadable(
        supplementReadOnly(parseSchema(r.Schema ?? '{}'), resourceType),
        resourceType
      ),
      resourceType
    );
  } catch {
    return EMPTY;
  }
}

// JSON pointer "/properties/A/B/*/C" -> dotted "A.B.*.C"
function pointerToDotted(p: string): string {
  // A JSON-pointer property path is `/properties/Foo/Bar`. Some CFn registry schemas
  // (e.g. OpenSearch `conditionalCreateOnlyProperties`) emit an INTERIOR or TRAILING
  // `/properties/` segment — `/properties/EncryptionAtRestOptions/properties` (the
  // block itself) or `/properties/AdvancedSecurityOptions/properties/Enabled`. Strip
  // the leading one, collapse any interior `/properties/` to the real nesting boundary,
  // and drop a trailing `/properties`, so the dotted path matches the actual model key
  // (`EncryptionAtRestOptions`, `AdvancedSecurityOptions.Enabled`) instead of keeping a
  // literal `properties` segment that matches nothing.
  return p
    .replace(/^\/properties\//, '')
    .replace(/\/properties\//g, '/')
    .replace(/\/properties$/, '')
    .replace(/\//g, '.');
}

// Unlike readOnly/writeOnly/createOnly (CFn pre-flattens those into pointer
// arrays), nested `default` annotations live inline on the property schemas
// (incl. inside `definitions`, reached via `$ref`). Walk the schema resolving
// local `#/definitions/...` refs and collect every `default` keyed by its dotted
// path — array `items` contribute a `*` segment, matching the readOnlyPaths
// convention and the `[id]`->`*`-normalized live finding paths. The per-branch
// `seen` ref-set breaks recursive definitions (a $ref cannot expand inside its
// own descent). Best-effort: only `properties` + `items` are descended (not
// oneOf/anyOf/allOf), so a missed default just stays `undeclared` — never a false
// positive.
type SchemaNode = {
  $ref?: string;
  default?: unknown;
  type?: string;
  insertionOrder?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
};
function collectDefaultPaths(
  definitions: Record<string, SchemaNode>,
  properties: Record<string, SchemaNode>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (node: SchemaNode | undefined, path: string, seen: ReadonlySet<string>): void => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const name = node.$ref.replace('#/definitions/', '');
      if (seen.has(name)) return; // recursive definition — stop
      walk(definitions[name], path, new Set(seen).add(name));
      return;
    }
    if ('default' in node && path) out[path] = node.default;
    if (node.properties)
      for (const [k, child] of Object.entries(node.properties))
        walk(child, path ? `${path}.${k}` : k, seen);
    if (node.items) walk(node.items, path ? `${path}.*` : '*', seen);
  };
  for (const [k, child] of Object.entries(properties)) walk(child, k, new Set());
  return out;
}

// Collect the dotted paths of arrays the schema marks `insertionOrder: false` (AWS
// declaring the array UNORDERED), split by item shape — a reorder of either is never
// drift (AWS may echo the set in its own canonical order), so classify folds them
// WITHOUT a per-type table:
//   - `scalar`: items resolve to a SCALAR type — classify folds a same-multiset
//     difference at one of these paths (isEqualUnorderedScalarSet).
//   - `object`: items are OBJECTS with NO identity field (Key/Id/AttributeName/
//     IndexName/Name) — classify sorts BOTH sides by canonical JSON before the
//     positional diff, the schema-driven twin of UNORDERED_OBJECT_ARRAY_PROPS (#459;
//     found live on AccessAnalyzer ArchiveRules, whose RuleName is not an identity
//     field). Identity-keyed object arrays (Tags et al.) are EXCLUDED: they are
//     already deterministically aligned by canonicalizeTagListsDeep, and a second
//     canonical-JSON sort would churn that established order for zero gain.
// Paths reached THROUGH an array element (which would carry a `*` segment) are
// skipped — classify matches an exact dotted drift path, and those rarer
// nested-under-array sets stay on the per-type allowlists. Same $ref-resolving,
// recursion-guarded walk as collectDefaultPaths; best-effort (a missed array just
// stays on the manual table — never a false positive).
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
// Mirrors noise.ts IDENTITY_FIELDS (the keys canonicalizeTagListsDeep aligns on).
const ITEM_IDENTITY_FIELDS = ['Key', 'Id', 'AttributeName', 'IndexName', 'Name'];
function collectUnorderedArrayPaths(
  definitions: Record<string, SchemaNode>,
  properties: Record<string, SchemaNode>
): { scalar: string[]; object: string[] } {
  const scalar: string[] = [];
  const object: string[] = [];
  const resolve = (
    node: SchemaNode | undefined,
    seen: ReadonlySet<string>
  ): SchemaNode | undefined => {
    let n = node;
    const s = new Set(seen);
    while (n?.$ref) {
      const name = n.$ref.replace('#/definitions/', '');
      if (s.has(name)) return undefined; // recursive — stop
      s.add(name);
      n = definitions[name];
    }
    return n;
  };
  const isScalarItems = (it: SchemaNode | undefined): boolean => {
    if (!it) return false;
    if (it.properties) return false; // object items
    if (Array.isArray(it.enum) && it.enum.every((v) => typeof v !== 'object')) return true;
    return typeof it.type === 'string' && SCALAR_TYPES.has(it.type);
  };
  const isNonIdentityObjectItems = (it: SchemaNode | undefined): boolean => {
    if (!it) return false;
    const propKeys = Object.keys(it.properties ?? {});
    if (propKeys.length === 0) return false; // scalar or free-form — not a structured object set
    return !propKeys.some((k) => ITEM_IDENTITY_FIELDS.includes(k));
  };
  const walk = (node: SchemaNode | undefined, path: string, seen: ReadonlySet<string>): void => {
    const n = resolve(node, seen);
    if (!n) return;
    const nextSeen = node?.$ref ? new Set(seen).add(node.$ref.replace('#/definitions/', '')) : seen;
    if (n.type === 'array') {
      if (n.insertionOrder === false && path && !path.includes('*')) {
        const it = resolve(n.items, nextSeen);
        if (isScalarItems(it)) scalar.push(path);
        else if (isNonIdentityObjectItems(it)) object.push(path);
      }
      if (n.items) walk(n.items, path ? `${path}.*` : '*', nextSeen); // descend (only finds '*' paths, skipped above)
    }
    if (n.properties)
      for (const [k, child] of Object.entries(n.properties))
        walk(child, path ? `${path}.${k}` : k, nextSeen);
  };
  for (const [k, child] of Object.entries(properties)) walk(child, k, new Set());
  return { scalar: [...new Set(scalar)].sort(), object: [...new Set(object)].sort() };
}

// Collect the dotted paths of FREE-FORM MAP properties: a `type: object` schema node with
// NO fixed `properties` whose contents are open — declared via `patternProperties` (regex
// keys, e.g. Lambda Environment.Variables `[a-zA-Z][a-zA-Z0-9_]+`) or an object-valued
// `additionalProperties` (Glue Parameters, ECS DockerLabels). Every key under such a node
// is user-authored data, never an AWS-materialized nested default, so classify surfaces a
// live-only sub-key there instead of folding it (R96 `undeclared-subkey`). A node with
// fixed `properties` (a structured object) is NOT a free-form map even if it also allows
// additionalProperties. Same $ref-resolving, recursion-guarded walk as the collectors
// above; best-effort (a missed map just keeps folding — never a false positive). A map
// NESTED UNDER AN ARRAY ELEMENT is KEPT (its path carries a `*` segment — ECS
// ContainerDefinitions.*.DockerLabels / .LogConfiguration.Options, Volumes.*
// .DockerVolumeConfiguration.Labels): classify matches via `startsWith` on the live
// `[id]`->`*`-normalized path, so the `*` aligns (unlike the EXACT-match collectors above,
// which skip `*`). Such a key is still surfaced (visibility); revert stays barred for it
// because its live path carries the array bracket (isUnrevertableNested). A `Tags` bag is
// EXCLUDED even when map-shaped — see the inline note (tags fold consistently with the
// dominant LIST-shaped Tags, so map-tagged resources are not noisier on the first run).
function collectFreeFormMapPaths(
  definitions: Record<string, SchemaNode>,
  properties: Record<string, SchemaNode>
): string[] {
  const out: string[] = [];
  const isObjectSchema = (v: boolean | SchemaNode | undefined): v is SchemaNode =>
    typeof v === 'object' && v !== null;
  const walk = (node: SchemaNode | undefined, path: string, seen: ReadonlySet<string>): void => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const name = node.$ref.replace('#/definitions/', '');
      if (seen.has(name)) return; // recursive — stop
      walk(definitions[name], path, new Set(seen).add(name));
      return;
    }
    const hasFixedProps = node.properties && Object.keys(node.properties).length > 0;
    const isMap =
      node.type === 'object' &&
      !hasFixedProps &&
      ((node.patternProperties && Object.keys(node.patternProperties).length > 0) ||
        isObjectSchema(node.additionalProperties));
    // A `Tags` bag is EXCLUDED even when MAP-shaped (AWS::SSM::Parameter et al. model
    // Tags as a patternProperties map, while most types use a {Key,Value}[] LIST). Tags
    // are a special low-signal category the pipeline already handles separately
    // (canonicalizeTagLists / stripAwsTagsDeep / tagPreservingOps); surfacing an undeclared
    // map-tag key as freeFormKey would make map-tagged resources noisier on the first run
    // than LIST-tagged ones (whose nested `Tags[<id>]` keys fold) — an inconsistency users
    // can't see the cause of. So a map-tag key FOLDS like a list-tag key (still recorded by
    // record; a change after record surfaces as drift; still revertable via path shape).
    const lastSeg = path.split('.').at(-1);
    if (isMap && path && lastSeg !== 'Tags') out.push(path);
    if (node.properties)
      for (const [k, child] of Object.entries(node.properties))
        walk(child, path ? `${path}.${k}` : k, seen);
    if (node.items) walk(node.items, path ? `${path}.*` : '*', seen);
  };
  for (const [k, child] of Object.entries(properties)) walk(child, k, new Set());
  return [...new Set(out)].sort();
}

/** Exported for unit testing without an AWS call. */
export function parseSchema(schemaJson: string): SchemaInfo {
  const schema = JSON.parse(schemaJson) as {
    readOnlyProperties?: string[];
    writeOnlyProperties?: string[];
    createOnlyProperties?: string[];
    conditionalCreateOnlyProperties?: string[];
    properties?: Record<string, SchemaNode>;
    definitions?: Record<string, SchemaNode>;
  };
  const dotted = (arr: string[] | undefined): string[] => (arr ?? []).map(pointerToDotted);
  const topLevel = (paths: string[]): Set<string> => new Set(paths.filter((p) => !p.includes('.')));
  const readOnlyPaths = dotted(schema.readOnlyProperties);
  const writeOnlyPaths = dotted(schema.writeOnlyProperties);
  // Only HARD `createOnlyProperties` bar a revert. `conditionalCreateOnlyProperties`
  // are create-only ONLY in specific cases (e.g. an RDS read replica) — in the common
  // case they are MUTABLE in place (RDS BackupRetentionPeriod / MultiAZ / StorageType /
  // PreferredMaintenanceWindow / AutoMinorVersionUpgrade are all modifiable via
  // ModifyDBInstance). Merging them in barred revert of these everyday props with a
  // misleading "create-only — requires replacement" (a revert false-negative on a very
  // common resource). They are NOT barred now: a revert attempts the in-place change
  // and, if a specific change truly needs replacement, Cloud Control UpdateResource
  // rejects it cleanly (it never silently replaces) — an honest failure beats a silent
  // bar. (Live-confirmed on AWS::RDS::DBInstance BackupRetentionPeriod.)
  const createOnlyPaths = dotted(schema.createOnlyProperties);
  const defaults: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (def && typeof def === 'object' && 'default' in def) defaults[k] = def.default;
  }
  const defaultPaths = collectDefaultPaths(schema.definitions ?? {}, schema.properties ?? {});
  const unorderedArrayPaths = collectUnorderedArrayPaths(
    schema.definitions ?? {},
    schema.properties ?? {}
  );
  const freeFormMapPaths = collectFreeFormMapPaths(
    schema.definitions ?? {},
    schema.properties ?? {}
  );
  return {
    readOnly: topLevel(readOnlyPaths),
    writeOnly: topLevel(writeOnlyPaths),
    createOnly: topLevel(createOnlyPaths),
    readOnlyPaths,
    writeOnlyPaths,
    createOnlyPaths,
    defaults,
    defaultPaths,
    unorderedScalarPaths: unorderedArrayPaths.scalar,
    unorderedObjectArrayPaths: unorderedArrayPaths.object,
    freeFormMapPaths,
  };
}

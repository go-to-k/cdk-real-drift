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
  // CognitoEvents is writeOnly in the registry schema (CC GetResource never returns it),
  // but readCognitoIdentityPool projects it from the cognito-sync API, so compare it.
  // PushSync / CognitoStreams stay writeOnly readGaps (the override does not project them).
  'AWS::Cognito::IdentityPool': ['CognitoEvents'],
  // AWS::SSM::Parameter `Description`/`AllowedPattern` are writeOnly (CC never echoes
  // them), but the SDK_SUPPLEMENTS reader fetches them via ssm:DescribeParameters —
  // so they must NOT be writeOnly-stripped/readGap'd, they should be compared like
  // any readable prop. (Tier/Policies stay writeOnly: the supplement does not project
  // them — Tier resolves Intelligent-Tiering to a real tier, Policies changes shape.)
  'AWS::SSM::Parameter': ['Description', 'AllowedPattern'],
  // AWS::ElastiCache::ReplicationGroup PreferredMaintenanceWindow / NotificationTopicArn
  // / EngineVersion are writeOnly on the RG (CC never echoes them); the SDK_SUPPLEMENTS
  // reader fetches them VERBATIM from the member cache cluster, so compare, not readGap.
  'AWS::ElastiCache::ReplicationGroup': [
    'PreferredMaintenanceWindow',
    'NotificationTopicArn',
    'EngineVersion',
  ],
};

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
    return exemptOverrideReadable(parseSchema(r.Schema ?? '{}'), resourceType);
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
// declaring the array UNORDERED) whose items resolve to a SCALAR type. A reorder of
// such an array is never drift — AWS may echo it in its own canonical order — so
// classify folds a same-multiset difference at one of these paths WITHOUT a per-type
// table. Scoped to SCALAR-item arrays: an unordered OBJECT array (e.g. ECS
// ContainerDefinitions, which is also insertionOrder:false) is keyed/sorted elsewhere
// (canonicalizeTagListsDeep / the per-type object-array tables), and a blanket scalar
// sort must not touch it. Paths reached THROUGH an array element (which would carry a
// `*` segment) are skipped — classify matches an exact dotted drift path, and those
// rarer nested-under-array sets stay on the per-type allowlist. Same $ref-resolving,
// recursion-guarded walk as collectDefaultPaths; best-effort (a missed array just
// stays on the manual table — never a false positive).
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
function collectUnorderedScalarPaths(
  definitions: Record<string, SchemaNode>,
  properties: Record<string, SchemaNode>
): string[] {
  const out: string[] = [];
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
  const isScalarItems = (items: SchemaNode | undefined, seen: ReadonlySet<string>): boolean => {
    const it = resolve(items, seen);
    if (!it) return false;
    if (it.properties) return false; // object items
    if (Array.isArray(it.enum) && it.enum.every((v) => typeof v !== 'object')) return true;
    return typeof it.type === 'string' && SCALAR_TYPES.has(it.type);
  };
  const walk = (node: SchemaNode | undefined, path: string, seen: ReadonlySet<string>): void => {
    const n = resolve(node, seen);
    if (!n) return;
    const nextSeen = node?.$ref ? new Set(seen).add(node.$ref.replace('#/definitions/', '')) : seen;
    if (n.type === 'array') {
      if (
        n.insertionOrder === false &&
        path &&
        !path.includes('*') &&
        isScalarItems(n.items, nextSeen)
      )
        out.push(path);
      if (n.items) walk(n.items, path ? `${path}.*` : '*', nextSeen); // descend (only finds '*' paths, skipped above)
    }
    if (n.properties)
      for (const [k, child] of Object.entries(n.properties))
        walk(child, path ? `${path}.${k}` : k, nextSeen);
  };
  for (const [k, child] of Object.entries(properties)) walk(child, k, new Set());
  return [...new Set(out)].sort();
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
// because its live path carries the array bracket (isUnrevertableNested).
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
    if (isMap && path) out.push(path);
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
  // createOnly + conditionalCreateOnly both mean "you cannot change this in place"
  // (a full / conditional replacement is required) — treat both as not-revertable.
  const createOnlyPaths = [
    ...dotted(schema.createOnlyProperties),
    ...dotted(schema.conditionalCreateOnlyProperties),
  ];
  const defaults: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (def && typeof def === 'object' && 'default' in def) defaults[k] = def.default;
  }
  const defaultPaths = collectDefaultPaths(schema.definitions ?? {}, schema.properties ?? {});
  const unorderedScalarPaths = collectUnorderedScalarPaths(
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
    unorderedScalarPaths,
    freeFormMapPaths,
  };
}

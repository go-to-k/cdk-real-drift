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

async function fetch(client: CloudFormationClient, resourceType: string): Promise<SchemaInfo> {
  try {
    const r = await client.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );
    return parseSchema(r.Schema ?? '{}');
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
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
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
  return {
    readOnly: topLevel(readOnlyPaths),
    writeOnly: topLevel(writeOnlyPaths),
    createOnly: topLevel(createOnlyPaths),
    readOnlyPaths,
    writeOnlyPaths,
    createOnlyPaths,
    defaults,
    defaultPaths,
  };
}

// Fetch a CloudFormation resource schema via describe-type and derive the
// readOnly / writeOnly / default sets used for noise suppression — both as
// top-level name sets (fast checks) and as full dotted paths (nested strip).
import { type CloudFormationClient, DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import type { SchemaInfo } from '../types.js';

const cache = new Map<string, SchemaInfo>();
const EMPTY: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  defaults: {},
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
  return p.replace(/^\/properties\//, '').replace(/\//g, '.');
}

/** Exported for unit testing without an AWS call. */
export function parseSchema(schemaJson: string): SchemaInfo {
  const schema = JSON.parse(schemaJson) as {
    readOnlyProperties?: string[];
    writeOnlyProperties?: string[];
    properties?: Record<string, { default?: unknown }>;
  };
  const dotted = (arr: string[] | undefined): string[] => (arr ?? []).map(pointerToDotted);
  const topLevel = (paths: string[]): Set<string> => new Set(paths.filter((p) => !p.includes('.')));
  const readOnlyPaths = dotted(schema.readOnlyProperties);
  const writeOnlyPaths = dotted(schema.writeOnlyProperties);
  const defaults: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (def && typeof def === 'object' && 'default' in def) defaults[k] = def.default;
  }
  return {
    readOnly: topLevel(readOnlyPaths),
    writeOnly: topLevel(writeOnlyPaths),
    readOnlyPaths,
    writeOnlyPaths,
    defaults,
  };
}

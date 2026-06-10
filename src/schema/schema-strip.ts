// Fetch a CloudFormation resource schema via describe-type and derive the
// top-level readOnly / writeOnly / default sets used for noise suppression.
// (Nested-path stripping is a follow-up; top-level covers the dominant noise.)
import { DescribeTypeCommand, type CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { SchemaInfo } from '../types.js';

const cache = new Map<string, SchemaInfo>();

export async function getSchemaInfo(client: CloudFormationClient, resourceType: string): Promise<SchemaInfo> {
  const cached = cache.get(resourceType);
  if (cached) return cached;
  const info = await fetch(client, resourceType);
  cache.set(resourceType, info);
  return info;
}

async function fetch(client: CloudFormationClient, resourceType: string): Promise<SchemaInfo> {
  try {
    const r = await client.send(new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType }));
    return parseSchema(r.Schema ?? '{}');
  } catch {
    return { readOnly: new Set(), writeOnly: new Set(), defaults: {} };
  }
}

/** Exported for unit testing without an AWS call. */
export function parseSchema(schemaJson: string): SchemaInfo {
  const schema = JSON.parse(schemaJson) as {
    readOnlyProperties?: string[];
    writeOnlyProperties?: string[];
    properties?: Record<string, { default?: unknown }>;
  };
  const topLevel = (arr: string[] | undefined): Set<string> =>
    new Set((arr ?? []).map((p) => p.replace('/properties/', '').split('/')[0]));
  const defaults: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (def && typeof def === 'object' && 'default' in def) defaults[k] = def.default;
  }
  return { readOnly: topLevel(schema.readOnlyProperties), writeOnly: topLevel(schema.writeOnlyProperties), defaults };
}

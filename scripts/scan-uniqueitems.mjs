// Enumerate the `uniqueItems: true` SCALAR arrays across CloudFormation resource schemas
// that the schema does NOT also mark `insertionOrder: false` — the inventory of the
// set-reorder false-positive class (see [[uniqueitems-reorder-fp-class]] / PR #541).
//
// WHY: a scalar array a service treats as an unordered SET reads back in a different order
// than the template declared it, which a positional compare false-drifts. cdkrd folds this
// two ways: (1) the SCHEMA-driven `unorderedScalarPaths` fold, which keys on
// `insertionOrder: false` (src/schema/schema-strip.ts), and (2) the per-type
// `UNORDERED_ARRAY_PROPS` allowlist (src/normalize/noise.ts) for sets the schema leaves
// `insertionOrder: true`/absent but AWS still sorts. This script lists the arrays that fall
// through gap (1) — `uniqueItems: true` WITHOUT `insertionOrder: false` — so each can be
// triaged against gap (2).
//
// TRIAGE (the script cannot decide this — it needs the element VALUE shape, not the schema):
//   - If the array's elements are AWS resource ids / ARNs (sg-*, subnet-*, arn:...), AZ
//     names, or HTTP-method verbs, they are ALREADY folded order-insensitively by the
//     GENERIC content-based canonicalizers (`isIdLike` / `isAvailabilityZone` /
//     `HTTP_METHODS` in src/normalize/noise.ts) — NO per-type entry needed. Live-proven on
//     RDS/Redshift VPCSecurityGroups (PR #550).
//   - Only sets whose elements are NON-id-like strings — branch globs, file paths, plain
//     names, or enum tokens the service sorts — need a manual `UNORDERED_ARRAY_PROPS` entry
//     (this is why CodePipeline Git trigger filters `release/*` / `src/**` needed PR #541).
// A `maxItems: 1` array can never reorder (Lambda ESM Topics/Queues) — reported but flagged.
//
// Usage:
//   A) Bulk (preferred) — scan the whole public CFn schema set offline (no auth):
//        curl -sS -o /tmp/cfnschema.zip \
//          https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip
//        mkdir -p /tmp/cfnschema && unzip -q /tmp/cfnschema.zip -d /tmp/cfnschema
//        node scripts/scan-uniqueitems.mjs /tmp/cfnschema
//   B) Ad hoc — specific types via `aws cloudformation describe-type` (needs creds):
//        node scripts/scan-uniqueitems.mjs AWS::GuardDuty::Detector AWS::Events::Rule
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    'usage: node scripts/scan-uniqueitems.mjs <dir-of-cfn-schema-json> | <Type::Name>...'
  );
  console.error('(see the header comment for how to download the schema set)');
  process.exit(2);
}

const SCALAR = new Set(['string', 'integer', 'number', 'boolean']);
const MAX_DEPTH = 40;

// Resolve a `$ref` (local `#/definitions/Foo` only) against the schema, guarding cycles.
function resolve(node, defs, seen) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop();
    if (seen.has(name)) return {};
    return resolve(defs[name] ?? {}, defs, new Set(seen).add(name));
  }
  return node;
}

// Walk a schema, collecting scalar `uniqueItems` arrays that are not `insertionOrder:false`.
// A per-schema node BUDGET bounds the walk: some schemas (Bedrock, WAFv2, ...) have
// recursive `$ref` definitions that branch exponentially, so the depth cap alone is not
// enough to guarantee termination.
function scan(schema) {
  const defs = schema.definitions ?? {};
  const hits = [];
  let budget = 200000;
  const walk = (node, path, seen, depth) => {
    if (depth > MAX_DEPTH || --budget < 0) return;
    const n = resolve(node, defs, seen);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object' && n.properties) {
      for (const [k, v] of Object.entries(n.properties)) walk(v, [...path, k], seen, depth + 1);
    } else if (n.type === 'array') {
      const items = resolve(n.items ?? {}, defs, seen);
      const scalar = SCALAR.has(items.type);
      if (n.uniqueItems === true && n.insertionOrder !== false && scalar) {
        hits.push({
          path: path.join('.'),
          itemType: items.type,
          insertionOrder: n.insertionOrder === undefined ? 'absent' : String(n.insertionOrder),
          maxItems: n.maxItems,
        });
      }
      if (items.type === 'object' && items.properties) {
        for (const [k, v] of Object.entries(items.properties))
          walk(v, [...path, '*', k], seen, depth + 1);
      }
    }
  };
  for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, [k], new Set(), 0);
  return hits;
}

// Yield [typeName, schema] pairs from a directory of schema JSON or from describe-type.
function* sources() {
  if (
    args.length === 1 &&
    (() => {
      try {
        return statSync(args[0]).isDirectory();
      } catch {
        return false;
      }
    })()
  ) {
    for (const f of readdirSync(args[0])
      .filter((x) => x.endsWith('.json'))
      .sort()) {
      let schema;
      try {
        schema = JSON.parse(readFileSync(join(args[0], f), 'utf8'));
      } catch {
        continue;
      }
      yield [schema.typeName ?? f.replace(/\.json$/, ''), schema];
    }
    return;
  }
  for (const t of args) {
    let out;
    try {
      out = execFileSync(
        'aws',
        [
          'cloudformation',
          'describe-type',
          '--type',
          'RESOURCE',
          '--type-name',
          t,
          '--query',
          'Schema',
          '--output',
          'text',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      console.log(`[ERR]  ${t}: describe-type failed (throttling / unknown type / no creds)`);
      continue;
    }
    yield [t, JSON.parse(out)];
  }
}

let typesScanned = 0;
let typesWithHits = 0;
let totalHits = 0;
for (const [type, schema] of sources()) {
  typesScanned++;
  const hits = scan(schema);
  if (hits.length === 0) continue;
  typesWithHits++;
  totalHits += hits.length;
  console.log(`\n${type}`);
  for (const h of hits) {
    const cap = h.maxItems === 1 ? '  [maxItems:1 -> cannot reorder]' : '';
    console.log(`    ${h.path}  <${h.itemType}>  insertionOrder=${h.insertionOrder}${cap}`);
  }
}
console.log(
  `\n-- ${totalHits} uniqueItems scalar-array path(s) across ${typesWithHits}/${typesScanned} type(s) lack insertionOrder:false --`
);
console.log(
  'triage each per the header: id-like/AZ/method element sets are auto-folded; non-id-like sets may need an UNORDERED_ARRAY_PROPS entry.'
);

// Measure how many CloudFormation resource-schema properties carry a `default`
// annotation. This quantifies how much of cdkrd's `atDefault` fold the SCHEMA can
// do on its own (`schema.defaults` / `schema.defaultPaths` in
// src/schema/schema-strip.ts) vs how much must come from the hand-maintained
// KNOWN_DEFAULTS / KNOWN_DEFAULT_PATHS tables — see docs/ARCHITECTURE.md § 6.
//
// Finding (2026-06-22, 1605 types): only ~1% of properties carry a `default`
// (1.10% top-level, 1.34% incl. nested; 5.5% of types have any). So schema
// defaults are negligible — the low-noise outcome comes from absent-when-unset
// reads + isTrivialEmpty + KNOWN_DEFAULTS. Re-run after a CFn schema refresh to
// confirm the number still holds before leaning on schema coverage.
//
// Usage:
//   1. Download the public CloudFormation resource-schema set (no auth):
//        curl -sS -o /tmp/cfnschema.zip \
//          https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip
//        mkdir -p /tmp/cfnschema && unzip -q /tmp/cfnschema.zip -d /tmp/cfnschema
//   2. node scripts/measure-schema-defaults.mjs /tmp/cfnschema
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/measure-schema-defaults.mjs <dir-of-cfn-schema-json>');
  console.error('(see the header comment for how to download the schema set)');
  process.exit(2);
}

let topTotal = 0;
let topDef = 0; // top-level properties (mirrors schema.defaults)
let allTotal = 0;
let allDef = 0; // every property node anywhere (mirrors defaultPaths reach)
let types = 0;
let typesWithAnyTopDefault = 0;

// Count each child of a {name: schemaNode} `properties` map, recursing into nested
// object properties and array-item properties (the shape collectDefaultPaths walks).
function walkProps(props) {
  if (!props || typeof props !== 'object') return;
  for (const node of Object.values(props)) {
    if (!node || typeof node !== 'object') continue;
    allTotal++;
    if ('default' in node) allDef++;
    if (node.properties && typeof node.properties === 'object') walkProps(node.properties);
    const items = node.items;
    if (items && typeof items === 'object' && items.properties) walkProps(items.properties);
  }
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    continue; // skip non-schema / malformed json
  }
  types++;
  const props = schema.properties ?? {};
  const defs = schema.definitions ?? {};

  const tt = Object.keys(props).length;
  const td = Object.values(props).filter(
    (v) => v && typeof v === 'object' && 'default' in v
  ).length;
  topTotal += tt;
  topDef += td;
  if (td > 0) typesWithAnyTopDefault++;

  walkProps(props);
  for (const dv of Object.values(defs)) {
    if (dv && typeof dv === 'object' && dv.properties) walkProps(dv.properties);
  }
}

const pct = (n, d) => (d === 0 ? '0.00' : ((100 * n) / d).toFixed(2));
console.log(`resource types analyzed:           ${types}`);
console.log(
  `types with >=1 top-level default:  ${typesWithAnyTopDefault}  (${pct(typesWithAnyTopDefault, types)}%)`
);
console.log(`TOP-LEVEL properties:              ${topTotal}`);
console.log(`  with a \`default\`:                ${topDef}  (${pct(topDef, topTotal)}%)`);
console.log(`ALL property nodes (incl. nested): ${allTotal}`);
console.log(`  with a \`default\`:                ${allDef}  (${pct(allDef, allTotal)}%)`);

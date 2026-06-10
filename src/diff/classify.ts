// The heart of `check`: given a resource's resolved declared properties, its raw
// live state, and its schema info, classify every difference into a tier:
//   declared    — a declared property whose live value differs
//   undeclared  — a live property not declared, after noise subtraction (the differentiator)
//   readGap     — a declared property absent from the live read (CC-API can't read it back)
//   unresolved  — a declared property whose intrinsics couldn't be resolved (GetAtt) → skip
//
// Pure: no AWS calls. liveRaw is the CC API GetResource model (un-stripped).
import type { Finding, SchemaInfo, DesiredResource } from '../types.js';
import { calculateResourceDrift, deepEqual } from './drift-calculator.js';
import { stripCcApiAwsManagedFields } from '../normalize/cc-api-strip.js';
import { UNRESOLVED, hasUnresolved } from '../normalize/intrinsic-resolver.js';
import { KNOWN_DEFAULTS, isTrivialEmpty, isAllAwsTags, stripAwsTagsDeep } from '../normalize/noise.js';
import { normalizePoliciesDeep } from '../normalize/policy-canonical.js';
import { deepStripPaths } from '../normalize/path-strip.js';

export function classifyResource(
  resource: DesiredResource,
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
): Finding[] {
  const { logicalId, resourceType, physicalId, declared: declaredIn } = resource;
  const findings: Finding[] = [];

  // strip AWS-managed fields + drop aws:* tag elements + canonicalize policy docs
  const live = normalizePoliciesDeep(stripAwsTagsDeep(stripCcApiAwsManagedFields(liveRaw))) as Record<string, unknown>;
  const declared = normalizePoliciesDeep(declaredIn) as Record<string, unknown>;
  // schema-driven noise removal at ANY depth: readOnly is pure noise (strip from
  // live); writeOnly cannot be read back (strip from BOTH sides so it is never
  // compared, at top level or nested).
  deepStripPaths(live, schema.readOnlyPaths);
  deepStripPaths(live, schema.writeOnlyPaths);
  deepStripPaths(declared, schema.writeOnlyPaths);

  // declared drift (A3: declared key absent in live = read gap, not drift)
  for (const [k, v] of Object.entries(declared)) {
    if (schema.writeOnly.has(k)) continue;
    if (v === UNRESOLVED || hasUnresolved(v)) {
      findings.push({ tier: 'unresolved', logicalId, resourceType, path: k });
      continue;
    }
    if (!(k in live)) {
      findings.push({ tier: 'readGap', logicalId, resourceType, path: k, note: 'declared but not returned by live read' });
      continue;
    }
    for (const d of calculateResourceDrift({ [k]: v }, { [k]: live[k] })) {
      findings.push({ tier: 'declared', logicalId, resourceType, path: d.path, desired: d.stateValue, actual: d.awsValue });
    }
  }

  // undeclared (A1/A2/A4 + identity suppression)
  const knownDef = KNOWN_DEFAULTS[resourceType] ?? {};
  for (const [k, v] of Object.entries(live)) {
    if (k in declared) continue;
    if (schema.writeOnly.has(k)) continue;
    if (k in schema.defaults && deepEqual(v, schema.defaults[k])) continue;
    if (k in knownDef && deepEqual(v, knownDef[k])) continue;
    if (isAllAwsTags(v)) continue;
    if (physicalId !== undefined && v === physicalId) continue;
    if (isTrivialEmpty(v)) continue;
    findings.push({ tier: 'undeclared', logicalId, resourceType, path: k, actual: v });
  }

  return findings;
}

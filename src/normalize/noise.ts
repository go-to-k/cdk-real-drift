// Undeclared-property noise suppressors (slice fixes A1/A2/A4).
// Keep conservative — over-suppression hides real undeclared drift.

// A4: defaults AWS applies that are NOT in the CFn schema's `default` field.
export const KNOWN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'AWS::IAM::Role': { MaxSessionDuration: 3600, Path: '/', Description: '' },
};

// Strip AWS-managed (aws:*) tag ELEMENTS from the live side so a declared tag
// set (which never contains aws:* tags) compares equal to the live set (which
// AWS augments with aws:cloudformation:* etc.). Handles {Key,Value}[] lists and
// key->value maps; recurses so nested tag bags are covered too.
export function stripAwsTagsDeep(v: unknown): unknown {
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
      .map(stripAwsTagsDeep);
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith('aws:')) continue;
      out[k] = stripAwsTagsDeep(val);
    }
    return out;
  }
  return v;
}

// CFn tag lists ({Key,Value}[]) are UNORDERED sets: CDK declares them in one
// order, AWS returns them in another, so a positional diff reports false drift on
// every tagged resource (subnets being the worst offender). Canonicalize any
// array whose every element is an object with a string `Key` by sorting on Key
// (JSON tiebreak for stability). Applied to BOTH sides before the diff, so a
// reordered-but-equal tag set compares equal. Recurses so nested tag bags
// (LaunchTemplate TagSpecifications etc.) are covered too.
// ASSUMPTION: any array whose every element is an object with a string `Key` field
// is treated as an unordered set and sorted by Key. This can match non-tag shapes
// (e.g. SSM MaintenanceWindow Targets, which also use {Key,Values}), but no such
// Key-shaped AWS property is known to be order-significant, so sorting is safe.
export function canonicalizeTagListsDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeTagListsDeep);
    const allKeyed =
      mapped.length > 0 &&
      mapped.every(
        (t) => t && typeof t === 'object' && typeof (t as { Key?: unknown }).Key === 'string'
      );
    if (allKeyed) {
      return [...mapped].sort((a, b) => {
        const ka = (a as { Key: string }).Key;
        const kb = (b as { Key: string }).Key;
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

export function canonicalizeIdArraysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeIdArraysDeep);
    if (mapped.length > 1 && mapped.every(isIdLike))
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

// A1: trivially-empty/off values AWS returns for unset features.
export function isTrivialEmpty(v: unknown): boolean {
  if (v === false || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
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

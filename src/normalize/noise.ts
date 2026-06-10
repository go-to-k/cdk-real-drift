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
      .filter((t) => !(t && typeof t === 'object' && typeof (t as { Key?: unknown }).Key === 'string' && (t as { Key: string }).Key.startsWith('aws:')))
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
      v.every((t) => t && typeof t === 'object' && typeof (t as { Key?: unknown }).Key === 'string' && (t as { Key: string }).Key.startsWith('aws:'))
    );
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => k.startsWith('aws:'));
  }
  return false;
}

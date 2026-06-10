// Undeclared-property noise suppressors (slice fixes A1/A2/A4).
// Keep conservative — over-suppression hides real undeclared drift.

// A4: defaults AWS applies that are NOT in the CFn schema's `default` field.
export const KNOWN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'AWS::IAM::Role': { MaxSessionDuration: 3600, Path: '/', Description: '' },
};

// A1: trivially-empty/off values AWS returns for unset features.
export function isTrivialEmpty(v: unknown): boolean {
  if (v === false || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// A2: a {Key,Value}[] tag list whose every element is an AWS-managed (aws:*) tag.
export function isAllAwsTags(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (t) => t && typeof t === 'object' && typeof (t as { Key?: unknown }).Key === 'string' && ((t as { Key: string }).Key).startsWith('aws:'),
    )
  );
}

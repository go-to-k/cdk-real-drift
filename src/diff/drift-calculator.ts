// COPY from cdkd: src/analyzer/drift-calculator.ts (pure function, no deps).
// Signature to preserve:
//   calculateResourceDrift(stateProperties, awsProperties, { ignorePaths?, unionWalkObjects? })
//     → PropertyDrift[] { path, stateValue, awsValue }
// unionWalkObjects:true detects console-side map-key additions (undeclared map keys).
// ignorePaths is prefix-based (feed schema writeOnly paths + per-type unknown paths).
//
// TODO(phase2): copy verbatim, add policy-canonical pre-pass before compare.
export interface PropertyDrift {
  path: string;
  stateValue: unknown;
  awsValue: unknown;
}

export function calculateResourceDrift(
  _stateProperties: Record<string, unknown>,
  _awsProperties: Record<string, unknown>,
  _options?: { ignorePaths?: readonly string[]; unionWalkObjects?: boolean },
): PropertyDrift[] {
  throw new Error('copy from cdkd in phase 2');
}

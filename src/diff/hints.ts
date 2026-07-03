// Non-classifying, human-facing HINTS for findings whose live value has a recognizable
// external origin. A hint NEVER folds or re-tiers a finding — the divergence is still
// reported as real drift (an account-wide enablement the user did not expect must stay
// visible). It only annotates the finding with WHERE the value likely came from, so a
// puzzling "I never touched this" finding is self-explaining.
//
// The first (and currently only) recognized footprint is CloudWatch Application Signals /
// Lambda Insights auto-instrumentation. When enabled at the ACCOUNT/REGION level (a
// CloudWatch setting, not a per-resource console edit), AWS uniformly:
//   - adds the AWS-owned Lambda Insights extension LAYER to every function
//     (`arn:aws:lambda:<region>:<aws-owned-acct>:layer:LambdaInsightsExtension[-Arm64]:N`), and
//   - attaches a tracer / insights execution POLICY to each function's role
//     (`AWSLambdaTracerAccessExecutionRole-<uuid>` or `CloudWatchLambdaInsightsExecutionRolePolicy`).
// Neither is a CDK-declared intent, so cdkrd surfaces them (Layers = undeclared, the extra
// ManagedPolicyArns entry = declared drift) — correctly. This hint just names the source.
import type { Finding } from '../types.js';

const APP_SIGNALS_HINT =
  'looks like CloudWatch Application Signals / Lambda Insights auto-instrumentation — ' +
  'typically enabled at the account/region level (a CloudWatch setting), not a per-resource ' +
  'edit; declare it in CDK to make it intent, or record/ignore to accept it';

// The AWS-owned Lambda Insights extension layer name is constant across regions (only the
// publisher account and version vary), so match on the layer-name segment.
const INSIGHTS_LAYER = /:layer:LambdaInsightsExtension(-Arm64)?:/;

// The two managed policies Application Signals / Lambda Insights attach to a function's
// execution role. The tracer policy carries a random UUID suffix, so match the stable stem.
const INSIGHTS_POLICY =
  /(AWSLambdaTracerAccessExecutionRole|CloudWatchLambdaInsightsExecutionRolePolicy)/;

/** All string leaves of a value (scalar, array, or nested) — flattened. Pure. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

/**
 * The hint for a single finding, or undefined if none applies. Pure + exported for tests.
 * Path is matched leniently (bare `Layers`, an indexed `Layers[0]`, or a nested
 * `...ManagedPolicyArns`) so the same detector fires whether the property surfaced whole or
 * per-element. For the role policy — a DECLARED drift carrying both sides — only the
 * LIVE-ONLY entries (actual minus desired) are inspected, so a hint fires on the ADDED
 * policy, never on one the template already declared.
 */
export function findingHint(f: Finding): string | undefined {
  if (f.resourceType === 'AWS::Lambda::Function' && /(^|\.)Layers(\[|$)/.test(f.path)) {
    if (strings(f.actual).some((s) => INSIGHTS_LAYER.test(s))) return APP_SIGNALS_HINT;
  }
  if (f.resourceType === 'AWS::IAM::Role' && /(^|\.)ManagedPolicyArns(\[|$)/.test(f.path)) {
    const declared = new Set(strings(f.desired));
    const liveOnly = strings(f.actual).filter((s) => !declared.has(s));
    if (liveOnly.some((s) => INSIGHTS_POLICY.test(s))) return APP_SIGNALS_HINT;
  }
  return undefined;
}

/**
 * Return a copy of `findings` with a `hint` set on any finding whose live value has a
 * recognized external origin. Non-mutating; leaves an already-set hint untouched. Applied
 * just before the report so both the text and --json outputs carry it.
 */
export function annotateHints(findings: Finding[]): Finding[] {
  return findings.map((f) => {
    if (f.hint !== undefined) return f;
    const hint = findingHint(f);
    return hint === undefined ? f : { ...f, hint };
  });
}

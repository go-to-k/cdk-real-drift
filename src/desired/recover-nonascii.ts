// Recover non-ASCII string literals that CloudFormation's GetTemplate masked as `?`.
//
// GetTemplate (cdkrd's declared source) replaces every non-ASCII character in a stored
// string literal with a literal `?` — see `isCfnTemplateNonAsciiMask`. CloudFormation
// compares against the INTACT value server-side (its own drift detection reports such a
// property IN_SYNC), but the value it exposes through GetTemplate is lossy, so a
// client-side compare against the live value would false-flag every check. Without a
// recovery source the property degrades to a `readGap` (declared-but-unverifiable):
// honest, but cdkrd then detects LESS than `cdk drift` on that property.
//
// The LOCAL synth template (the cdk.out assembly cdkrd already produces for stack
// discovery) carries the intact UTF-8. When the synth value at the SAME template path
// masks to the deployed `?`-value (same ASCII skeleton, same length, ≥1 non-ASCII char),
// it IS the deployed declared value with its non-ASCII recovered — substitute it so the
// comparison runs on real text and a genuine out-of-band non-ASCII change is detectable.
//
// Gated per-value by the mask: a synth value whose ASCII skeleton or length does NOT
// match the deployed mask (the local code diverged structurally from what is deployed)
// is NEVER substituted — that property stays a `readGap`. So this only ever fires on the
// exact values GetTemplate corrupted; a pure-ASCII template is untouched (GetTemplate
// never masks ASCII, so no `?`-leaf ever matches a non-ASCII synth value).
import { isCfnTemplateNonAsciiMask } from '../normalize/noise.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Walk the parsed DEPLOYED template and the LOCAL synth template in parallel by
// key/index; replace any deployed string leaf that is a non-ASCII GetTemplate mask of the
// synth value with the (intact) synth value. Returns the recovered template; mutates
// nested objects/arrays of `deployed` in place (callers pass the freshly parsed template).
export function recoverNonAsciiMasks(deployed: unknown, recovery: unknown): unknown {
  if (typeof deployed === 'string') {
    return typeof recovery === 'string' && isCfnTemplateNonAsciiMask(deployed, recovery)
      ? recovery
      : deployed;
  }
  if (Array.isArray(deployed) && Array.isArray(recovery)) {
    for (let i = 0; i < deployed.length; i++) {
      deployed[i] = recoverNonAsciiMasks(deployed[i], recovery[i]);
    }
    return deployed;
  }
  if (isObject(deployed) && isObject(recovery)) {
    for (const k of Object.keys(deployed)) {
      deployed[k] = recoverNonAsciiMasks(deployed[k], recovery[k]);
    }
    return deployed;
  }
  return deployed;
}

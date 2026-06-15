// Minimal CloudFormation intrinsic resolver for declared-property comparison.
// Resolves Ref / Fn::Sub / Fn::If (+ condition eval) / Fn::Join / Fn::Select /
// Fn::FindInMap / Fn::Split / Fn::ImportValue (exports prefetched by loadDesired).
// Fn::GetAtt resolves to UNRESOLVED (needs live attributes) so callers skip that
// path rather than report false drift. AWS::NoValue resolves to NOVALUE so callers
// can prune it. (Will be swapped for cdkd's full IntrinsicFunctionResolver later.)
import type { ResolverContext } from '../types.js';

export const UNRESOLVED = Symbol('unresolved');
export const NOVALUE = Symbol('novalue');

// CloudFormation dynamic-reference pattern: `{{resolve:<service>:<reference-key>}}`
// where <service> is one of ssm / ssm-secure / secretsmanager. These are resolved by
// CFn at deploy time to a live SSM/Secrets value, so a declared scalar carrying the
// raw token can never equal the resolved live value — it must be treated as
// UNRESOLVED. Anchored to the whole string so an arbitrary value that merely contains
// the substring is not swallowed (a genuine declared value is never muted by accident).
const DYNAMIC_REFERENCE_RE = /^\{\{resolve:(ssm|ssm-secure|secretsmanager):[\s\S]+\}\}$/;
export function isDynamicReference(v: string): boolean {
  return DYNAMIC_REFERENCE_RE.test(v);
}

// A value safe to interpolate into a joined / substituted STRING: a primitive
// (string / number / boolean). A symbol (UNRESOLVED / NOVALUE) or an object / array
// means resolution was incomplete (a deep GetAtt) or the template is malformed —
// fail closed to UNRESOLVED rather than leak `[object Object]` / `Symbol(unresolved)`
// into the declared value, which would then mis-compare as false drift. (`Fn::Join`
// filters NOVALUE out of the list FIRST, so its remaining non-scalar parts are the
// genuinely-unresolved ones.)
function isScalarInterpolant(v: unknown): boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

export function resolve(node: unknown, ctx: ResolverContext): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(n, ctx));
  // A CloudFormation DYNAMIC REFERENCE (`{{resolve:ssm:…}}`,
  // `{{resolve:ssm-secure:…}}`, `{{resolve:secretsmanager:…}}`) is a deploy-time
  // string substitution: CFn replaces it with the live SSM parameter / secret value
  // while creating the resource, so the deployed template still carries the literal
  // `{{resolve:…}}` token but the live resource holds the resolved value (e.g. an
  // RDS MasterUsername declared as `{{resolve:secretsmanager:…:username::}}` reads
  // back as `admin`). cdkrd cannot — and must not — fetch the secret to resolve it,
  // so the declared side is unknowable: mark UNRESOLVED so the path is skipped, the
  // same fail-closed treatment as Fn::GetAtt, never reported as false drift.
  if (typeof node === 'string' && isDynamicReference(node)) return UNRESOLVED;
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0]!;
    const v = obj[k];
    switch (k) {
      case 'Ref':
        return resolveRef(String(v), ctx);
      case 'Fn::Sub':
        return resolveSub(v, ctx);
      case 'Fn::If': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const [cond, t, f] = v as [string, unknown, unknown];
        const c = evalCondition(String(cond), ctx);
        // Fail-closed: if the condition can't be cleanly evaluated, do NOT guess a
        // branch (a wrong branch silently produces false drift) — mark unresolved.
        if (c === UNRESOLVED) return UNRESOLVED;
        return c ? resolve(t, ctx) : resolve(f, ctx);
      }
      case 'Fn::Join': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const [delim, list] = v as [string, unknown];
        const resolved = resolve(list, ctx);
        if (!Array.isArray(resolved)) return UNRESOLVED;
        const parts = resolved.filter((p) => p !== NOVALUE);
        // Any non-scalar remaining part (the UNRESOLVED symbol, OR a nested
        // object/array that leaked from a deep unresolved GetAtt / malformed list)
        // means we cannot faithfully join — fail closed rather than String()-leak.
        if (parts.some((p) => !isScalarInterpolant(p))) return UNRESOLVED;
        const joined = parts.join(delim);
        // CDK frequently ASSEMBLES a dynamic reference with Fn::Join (e.g. an RDS
        // MasterUsername = Join("", ["{{resolve:secretsmanager:", Ref(secret),
        // ":SecretString:username::}}"])); once joined the result is a deploy-time
        // dynamic reference cdkrd cannot resolve — UNRESOLVED, never false drift.
        return isDynamicReference(joined) ? UNRESOLVED : joined;
      }
      case 'Fn::Select': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const [idx, list] = v as [number, unknown];
        const arr = resolve(list, ctx);
        if (!Array.isArray(arr)) return UNRESOLVED;
        const i = Number(idx);
        // Fail-closed: out-of-range index (or a NaN index) would otherwise yield
        // `undefined` and report false `desired: undefined` drift. The selected
        // element itself being UNRESOLVED also propagates.
        if (!Number.isInteger(i) || i < 0 || i >= arr.length) return UNRESOLVED;
        const sel = arr[i];
        return sel === UNRESOLVED ? UNRESOLVED : sel;
      }
      case 'Fn::FindInMap': {
        if (!Array.isArray(v) || v.length < 3) return UNRESOLVED;
        const [mapName, topKey, secondKey] = v.map((x) => resolve(x, ctx));
        // All 3 keys must resolve to strings and the path must exist; else fail-closed.
        if (
          typeof mapName !== 'string' ||
          typeof topKey !== 'string' ||
          typeof secondKey !== 'string'
        )
          return UNRESOLVED;
        const val = ctx.mappings?.[mapName]?.[topKey]?.[secondKey];
        return val === undefined ? UNRESOLVED : val;
      }
      case 'Fn::Split': {
        if (!Array.isArray(v) || v.length < 2) return UNRESOLVED;
        const delim = v[0];
        const src = resolve(v[1], ctx);
        if (typeof delim !== 'string' || typeof src !== 'string') return UNRESOLVED;
        return src.split(delim);
      }
      case 'Fn::ImportValue': {
        const name = resolve(v, ctx);
        if (typeof name !== 'string') return UNRESOLVED;
        // Prefetched exports (see loadDesired); absent name -> fail-closed.
        return name in ctx.exports ? ctx.exports[name] : UNRESOLVED;
      }
      case 'Fn::GetAtt':
        return resolveGetAtt(v, ctx);
      case 'Fn::Equals': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const [a, b] = v.map((x) => resolve(x, ctx));
        if (a === UNRESOLVED || b === UNRESOLVED) return UNRESOLVED; // fail-closed
        return scalarEqual(a, b);
      }
      case 'Fn::And': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const rs = v.map((c) => condVal(c, ctx));
        if (rs.some((r) => r === UNRESOLVED)) return UNRESOLVED;
        return rs.every((r) => r === true);
      }
      case 'Fn::Or': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const rs = v.map((c) => condVal(c, ctx));
        if (rs.some((r) => r === UNRESOLVED)) return UNRESOLVED;
        return rs.some((r) => r === true);
      }
      case 'Fn::Not': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const r = condVal(v[0], ctx);
        return r === UNRESOLVED ? UNRESOLVED : !r;
      }
      case 'Condition':
        return evalCondition(String(v), ctx);
      default:
        // Any intrinsic we don't fully resolve → UNRESOLVED, so the declared
        // path is skipped (never reported as false drift).
        if (k.startsWith('Fn::')) return UNRESOLVED;
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [kk, vv] of Object.entries(obj)) out[kk] = resolve(vv, ctx);
  return out;
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// Evaluate a condition operand to true | false | UNRESOLVED (fail-closed).
function condVal(node: unknown, ctx: ResolverContext): boolean | typeof UNRESOLVED {
  if (node && typeof node === 'object' && 'Condition' in (node as object)) {
    const r = evalCondition(String((node as Record<string, unknown>)['Condition']), ctx);
    return r === UNRESOLVED ? UNRESOLVED : r === true;
  }
  const r = resolve(node, ctx);
  if (r === true) return true;
  if (r === false) return false;
  return UNRESOLVED;
}

export function evalCondition(name: string, ctx: ResolverContext): boolean | typeof UNRESOLVED {
  if (ctx.condCache.has(name)) return ctx.condCache.get(name) as boolean | typeof UNRESOLVED;
  const r = resolve(ctx.conditions[name], ctx);
  const val = r === true ? true : r === false ? false : UNRESOLVED;
  ctx.condCache.set(name, val);
  return val;
}

// Resolve Fn::GetAtt against the referenced resource's LIVE model (ctx.liveAttrs),
// NOT a guessed ARN format. `[LogicalId, AttrName]`; AttrName may be dotted
// (e.g. "Endpoint.Address"). Returns the live attribute value, or UNRESOLVED
// (fail-closed) when the target wasn't read or the attribute is absent — so a
// missing live read never fabricates a value or reports false drift. Comparing a
// GetAtt against the target's CURRENT attribute is still real drift detection on
// the CONSUMING resource (does it actually point at that attribute's value?).
export function resolveGetAtt(v: unknown, ctx: ResolverContext): unknown {
  if (!Array.isArray(v) || v.length < 2) return UNRESOLVED;
  const logicalId = String(v[0]);
  const attr = String(v[1]);
  const model = ctx.liveAttrs[logicalId];
  if (!model) return UNRESOLVED;
  const got = getPath(model, attr.split('.'));
  return got === undefined ? UNRESOLVED : got;
}

function getPath(obj: Record<string, unknown>, segs: string[]): unknown {
  let node: unknown = obj;
  for (const s of segs) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[s];
  }
  return node;
}

export function resolveRef(name: string, ctx: ResolverContext): unknown {
  if (name in ctx.pseudo) return ctx.pseudo[name];
  if (name === 'AWS::NoValue') return NOVALUE;
  if (name in ctx.params) return ctx.params[name];
  if (name in ctx.physIds) return ctx.physIds[name];
  return UNRESOLVED;
}

export function resolveSub(v: unknown, ctx: ResolverContext): unknown {
  let tmpl: string;
  let vars: Record<string, unknown> = {};
  if (typeof v === 'string') tmpl = v;
  else {
    const arr = v as [string, Record<string, unknown>];
    tmpl = arr[0];
    vars = arr[1] ?? {};
  }
  let unresolved = false;
  const out = tmpl.replace(/\$\{([^}]+)\}/g, (_m, ref: string) => {
    // ${!Literal} is the CFn escape for a literal "${Literal}" — emit verbatim,
    // do NOT attempt resolution.
    if (ref.startsWith('!')) return `\${${ref.slice(1)}}`;
    if (ref in vars) {
      const r = resolve(vars[ref], ctx);
      // Mirror the Ref / GetAtt branches below: a non-scalar resolution (UNRESOLVED,
      // NOVALUE, or a leaked object/array) cannot be interpolated — fail closed
      // instead of injecting `Symbol(novalue)` / `[object Object]` into the string.
      if (!isScalarInterpolant(r)) {
        unresolved = true;
        return '';
      }
      return String(r);
    }
    if (ref.includes('.')) {
      // ${LogicalId.Attr} GetAtt form — resolve against live attributes.
      const dot = ref.indexOf('.');
      const r = resolveGetAtt([ref.slice(0, dot), ref.slice(dot + 1)], ctx);
      if (r === UNRESOLVED || r === NOVALUE) {
        unresolved = true;
        return '';
      }
      return String(r);
    }
    const r = resolveRef(ref, ctx);
    if (r === UNRESOLVED || r === NOVALUE) {
      unresolved = true;
      return '';
    }
    return String(r);
  });
  if (unresolved) return UNRESOLVED;
  // an Fn::Sub may also ASSEMBLE a dynamic reference (`{{resolve:…}}`) — the
  // assembled token is deploy-time-resolved and unknowable, so UNRESOLVED.
  return isDynamicReference(out) ? UNRESOLVED : out;
}

export function hasUnresolved(v: unknown): boolean {
  if (v === UNRESOLVED) return true;
  if (Array.isArray(v)) return v.some(hasUnresolved);
  if (v && typeof v === 'object') return Object.values(v).some(hasUnresolved);
  return false;
}

export function pruneNoValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== NOVALUE).map(pruneNoValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === NOVALUE) continue;
      out[k] = pruneNoValue(val);
    }
    return out;
  }
  return v;
}

/** resolve + prune NoValue, returning a property bag ready for classification. */
export function resolveProperties(
  props: Record<string, unknown>,
  ctx: ResolverContext
): Record<string, unknown> {
  return pruneNoValue(resolve(props, ctx)) as Record<string, unknown>;
}

// Minimal CloudFormation intrinsic resolver for declared-property comparison.
// Resolves Ref / Fn::Sub / Fn::If (+ condition eval) / Fn::Join / Fn::Select.
// Fn::GetAtt resolves to UNRESOLVED (needs live attributes) so callers skip that
// path rather than report false drift. AWS::NoValue resolves to NOVALUE so callers
// can prune it. (Will be swapped for cdkd's full IntrinsicFunctionResolver later.)
import type { ResolverContext } from '../types.js';

export const UNRESOLVED = Symbol('unresolved');
export const NOVALUE = Symbol('novalue');

export function resolve(node: unknown, ctx: ResolverContext): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(n, ctx));
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0];
    const v = obj[k];
    switch (k) {
      case 'Ref':
        return resolveRef(String(v), ctx);
      case 'Fn::Sub':
        return resolveSub(v, ctx);
      case 'Fn::If': {
        const [cond, t, f] = v as [string, unknown, unknown];
        return evalCondition(cond, ctx) ? resolve(t, ctx) : resolve(f, ctx);
      }
      case 'Fn::Join': {
        const [delim, list] = v as [string, unknown[]];
        const parts = (resolve(list, ctx) as unknown[]).filter((p) => p !== NOVALUE);
        if (parts.some((p) => p === UNRESOLVED)) return UNRESOLVED;
        return parts.join(delim);
      }
      case 'Fn::Select': {
        const [idx, list] = v as [number, unknown[]];
        return (resolve(list, ctx) as unknown[])[Number(idx)];
      }
      case 'Fn::GetAtt':
        return UNRESOLVED;
      case 'Fn::Equals': {
        const [a, b] = (v as unknown[]).map((x) => resolve(x, ctx));
        return a === b;
      }
      case 'Fn::And':
        return (v as unknown[]).every((c) => truthyCond(c, ctx));
      case 'Fn::Or':
        return (v as unknown[]).some((c) => truthyCond(c, ctx));
      case 'Fn::Not':
        return !truthyCond((v as unknown[])[0], ctx);
      case 'Condition':
        return evalCondition(String(v), ctx);
      default:
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [kk, vv] of Object.entries(obj)) out[kk] = resolve(vv, ctx);
  return out;
}

function truthyCond(node: unknown, ctx: ResolverContext): boolean {
  if (node && typeof node === 'object' && 'Condition' in (node as object)) {
    return evalCondition(String((node as Record<string, unknown>)['Condition']), ctx);
  }
  return resolve(node, ctx) === true;
}

export function evalCondition(name: string, ctx: ResolverContext): boolean {
  if (ctx.condCache.has(name)) return ctx.condCache.get(name)!;
  const result = resolve(ctx.conditions[name], ctx) === true;
  ctx.condCache.set(name, result);
  return result;
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
    if (ref in vars) {
      const r = resolve(vars[ref], ctx);
      if (r === UNRESOLVED) { unresolved = true; return ''; }
      return String(r);
    }
    if (ref.includes('.')) { unresolved = true; return ''; } // GetAtt form
    const r = resolveRef(ref, ctx);
    if (r === UNRESOLVED || r === NOVALUE) { unresolved = true; return ''; }
    return String(r);
  });
  return unresolved ? UNRESOLVED : out;
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
export function resolveProperties(props: Record<string, unknown>, ctx: ResolverContext): Record<string, unknown> {
  return pruneNoValue(resolve(props, ctx)) as Record<string, unknown>;
}

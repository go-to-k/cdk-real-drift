// Phase 2 vertical slice — a REAL, runnable `check` against a deployed stack.
// Self-contained on purpose (single file, SDK-only imports) so it runs via
//   node --experimental-strip-types scripts/check-slice.ts <stack> [region]
// without a build step. Logic here will be decomposed into src/* modules next.
//
// Pipeline: GetTemplate + DescribeStackResources (desired/declared, intrinsic-resolved)
//   → CC API GetResource (live full state) → describe-type (readOnly/writeOnly/defaults)
//   → subtract noise → classify declared | undeclared | skipped → report.
import {
  CloudFormationClient,
  GetTemplateCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  DescribeTypeCommand,
} from '@aws-sdk/client-cloudformation';
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';

const [stackName, region = 'us-east-1'] = process.argv.slice(2);
if (!stackName) {
  console.error('usage: check-slice <stack> [region]');
  process.exit(2);
}
const cfn = new CloudFormationClient({ region });
const cc = new CloudControlClient({ region });

// ---------- intrinsic resolution (minimal, slice-scoped) ----------
const UNRESOLVED = Symbol('unresolved');
const NOVALUE = Symbol('novalue');

interface Ctx {
  params: Record<string, string>;
  pseudo: Record<string, string>;
  conditions: Record<string, unknown>;
  physIds: Record<string, string>; // logicalId -> physicalId
  condCache: Map<string, boolean>;
}

function resolve(node: unknown, ctx: Ctx): unknown {
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
        const arr = resolve(list, ctx) as unknown[];
        return arr[Number(idx)];
      }
      case 'Fn::GetAtt':
        return UNRESOLVED; // needs live attributes — slice skips these paths
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

function truthyCond(node: unknown, ctx: Ctx): boolean {
  if (node && typeof node === 'object' && 'Condition' in (node as object)) {
    return evalCondition(String((node as Record<string, unknown>)['Condition']), ctx);
  }
  return resolve(node, ctx) === true;
}

function evalCondition(name: string, ctx: Ctx): boolean {
  if (ctx.condCache.has(name)) return ctx.condCache.get(name)!;
  const def = ctx.conditions[name];
  const result = resolve(def, ctx) === true;
  ctx.condCache.set(name, result);
  return result;
}

function resolveRef(name: string, ctx: Ctx): unknown {
  if (name in ctx.pseudo) return ctx.pseudo[name];
  if (name === 'AWS::NoValue') return NOVALUE;
  if (name in ctx.params) return ctx.params[name];
  if (name in ctx.physIds) return ctx.physIds[name];
  return UNRESOLVED;
}

function resolveSub(v: unknown, ctx: Ctx): unknown {
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
      if (r === UNRESOLVED) {
        unresolved = true;
        return '';
      }
      return String(r);
    }
    if (ref.includes('.')) {
      unresolved = true;
      return '';
    } // GetAtt form
    const r = resolveRef(ref, ctx);
    if (r === UNRESOLVED || r === NOVALUE) {
      unresolved = true;
      return '';
    }
    return String(r);
  });
  return unresolved ? UNRESOLVED : out;
}

function hasUnresolved(v: unknown): boolean {
  if (v === UNRESOLVED) return true;
  if (Array.isArray(v)) return v.some(hasUnresolved);
  if (v && typeof v === 'object') return Object.values(v).some(hasUnresolved);
  return false;
}

// drop NoValue keys/elements from a resolved structure
function pruneNoValue(v: unknown): unknown {
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

// ---------- drift compare (copied from cdkd src/analyzer/drift-calculator.ts) ----------
interface PropertyDrift {
  path: string;
  stateValue: unknown;
  awsValue: unknown;
}
function calculateResourceDrift(
  stateProps: Record<string, unknown>,
  awsProps: Record<string, unknown>
): PropertyDrift[] {
  const drifts: PropertyDrift[] = [];
  for (const key of Object.keys(stateProps)) diffAt(key, stateProps[key], awsProps[key], drifts);
  return drifts;
}
function diffAt(path: string, sv: unknown, av: unknown, out: PropertyDrift[]): void {
  if (deepEqual(sv, av)) return;
  if (isObj(sv) && isObj(av) && !Array.isArray(sv) && !Array.isArray(av)) {
    for (const key of Object.keys(sv))
      diffAt(`${path}.${key}`, sv[key], (av as Record<string, unknown>)[key], out);
    return;
  }
  out.push({ path, stateValue: sv, awsValue: av });
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>,
    bo = b as Record<string, unknown>;
  const ak = Object.keys(ao),
    bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------- cc-api strip (copied from cdkd src/analyzer/cc-api-strip.ts) ----------
const ALWAYS_STRIPPED = new Set([
  'CreationDate',
  'CreationTime',
  'CreatedTime',
  'CreatedDate',
  'CreatedAt',
  'LastModifiedDate',
  'LastModifiedTime',
  'LastModified',
  'LastUpdatedTime',
  'LastUpdatedDate',
  'UpdatedAt',
  'OwnerId',
  'OwnerAccountId',
  'CreatedBy',
  'OwnerArn',
  'RevisionId',
  'LastUpdateStatus',
  'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode',
  'StackId',
  'PhysicalResourceId',
  'LogicalResourceId',
]);
function stripManaged(v: unknown): unknown {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(stripManaged);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v)) {
      if (ALWAYS_STRIPPED.has(k)) continue;
      out[k] = stripManaged(c);
    }
    return out;
  }
  return v;
}

// ---------- schema (describe-type → readOnly/writeOnly top-level + defaults) ----------
const schemaCache = new Map<
  string,
  { readOnly: Set<string>; writeOnly: Set<string>; defaults: Record<string, unknown> }
>();
async function getSchema(type: string) {
  if (schemaCache.has(type)) return schemaCache.get(type)!;
  const empty = {
    readOnly: new Set<string>(),
    writeOnly: new Set<string>(),
    defaults: {} as Record<string, unknown>,
  };
  try {
    const r = await cfn.send(new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: type }));
    const schema = JSON.parse(r.Schema ?? '{}');
    const top = (arr: string[] | undefined) =>
      new Set((arr ?? []).map((p) => p.replace('/properties/', '').split('/')[0]));
    const readOnly = top(schema.readOnlyProperties);
    const writeOnly = top(schema.writeOnlyProperties);
    const defaults: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(
      (schema.properties ?? {}) as Record<string, { default?: unknown }>
    )) {
      if (def && typeof def === 'object' && 'default' in def) defaults[k] = def.default;
    }
    const info = { readOnly, writeOnly, defaults };
    schemaCache.set(type, info);
    return info;
  } catch {
    schemaCache.set(type, empty);
    return empty;
  }
}

// ---------- noise normalizers (slice fixes A1-A4) ----------
// A4: defaults AWS applies that are NOT in the CFn schema's `default` field.
const KNOWN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'AWS::IAM::Role': { MaxSessionDuration: 3600, Path: '/', Description: '' },
};
// A1: trivially-empty/off values AWS returns for unset features (suppress as undeclared).
function isTrivialEmpty(v: unknown): boolean {
  if (v === false || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
// A2: a {Key,Value}[] tag list whose every element is an AWS-managed (aws:*) tag.
function isAllAwsTags(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof (t as any).Key === 'string' &&
        (t as any).Key.startsWith('aws:')
    )
  );
}

// ---------- main ----------
function parseTemplateBody(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    /* YAML */
  }
  // minimal: we only need Resources/Conditions/Parameters keys; for YAML stacks
  // fall back to a tolerant line walk is overkill — CDK app stacks are JSON.
  throw new Error(
    'template is YAML; slice supports JSON templates (CDK app output). Use a JSON-template stack.'
  );
}

async function main(): Promise<number> {
  const [tmplRes, resRes, stkRes] = await Promise.all([
    cfn.send(new GetTemplateCommand({ StackName: stackName })),
    cfn.send(new DescribeStackResourcesCommand({ StackName: stackName })),
    cfn.send(new DescribeStacksCommand({ StackName: stackName })),
  ]);
  const template = parseTemplateBody(tmplRes.TemplateBody ?? '{}');
  const stack = stkRes.Stacks?.[0];
  const accountId = stack?.StackId?.split(':')[4] ?? '';
  const physIds: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  for (const r of resRes.StackResources ?? []) {
    if (r.LogicalResourceId && r.PhysicalResourceId)
      physIds[r.LogicalResourceId] = r.PhysicalResourceId;
    if (r.LogicalResourceId && r.ResourceType) typeOf[r.LogicalResourceId] = r.ResourceType;
  }
  const params: Record<string, string> = {};
  for (const p of template.Parameters
    ? (Object.entries(template.Parameters) as [string, { Default?: unknown }][])
    : []) {
    if (p[1] && 'Default' in p[1]) params[p[0]] = String(p[1].Default);
  }
  for (const p of stack?.Parameters ?? [])
    if (p.ParameterKey) params[p.ParameterKey] = p.ParameterValue ?? '';
  const ctx: Ctx = {
    params,
    pseudo: {
      'AWS::Region': region,
      'AWS::AccountId': accountId,
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': stackName,
      'AWS::StackId': stack?.StackId ?? '',
    },
    conditions: template.Conditions ?? {},
    physIds,
    condCache: new Map(),
  };

  const tiers = {
    declared: [] as string[],
    undeclared: [] as string[],
    skipped: [] as string[],
    unresolved: [] as string[],
    readGap: [] as string[],
  };

  for (const [logicalId, res] of Object.entries(template.Resources ?? {}) as [string, any][]) {
    const type = res.Type as string;
    if (type === 'AWS::CDK::Metadata') continue;
    const physId = physIds[logicalId];
    if (!physId) {
      tiers.skipped.push(`${logicalId} (${type}) — no physical id`);
      continue;
    }

    // live read via CC API
    let live: Record<string, unknown>;
    try {
      const g = await cc.send(new GetResourceCommand({ TypeName: type, Identifier: physId }));
      live = JSON.parse(g.ResourceDescription?.Properties ?? '{}');
    } catch (e) {
      tiers.skipped.push(`${logicalId} (${type}) — CC API: ${(e as Error).name}`);
      continue;
    }

    const schema = await getSchema(type);
    live = stripManaged(live) as Record<string, unknown>;
    // strip readOnly top-level keys (noise)
    for (const k of schema.readOnly) delete live[k];

    // desired (declared), resolved + pruned
    const declaredRaw = (res.Properties ?? {}) as Record<string, unknown>;
    const declared = pruneNoValue(resolve(declaredRaw, ctx)) as Record<string, unknown>;

    // declared drift: compare each fully-resolved, non-writeOnly declared key.
    // A3: a declared key absent from the live read is a CC-API read gap, NOT drift.
    for (const [k, v] of Object.entries(declared)) {
      if (schema.writeOnly.has(k)) continue;
      if (hasUnresolved(v)) {
        tiers.unresolved.push(`${logicalId}.${k} (${type})`);
        continue;
      }
      if (!(k in live)) {
        tiers.readGap.push(`${logicalId}.${k} (${type}) — declared but not returned by live read`);
        continue;
      }
      for (const d of calculateResourceDrift({ [k]: v }, { [k]: live[k] })) {
        tiers.declared.push(
          `${logicalId}.${d.path} (${type})\n      desired=${j(d.stateValue)}\n      actual =${j(d.awsValue)}`
        );
      }
    }

    // undeclared: live keys not declared, after subtracting noise (A1/A2/A4 + identity).
    const knownDef = KNOWN_DEFAULTS[type] ?? {};
    for (const [k, v] of Object.entries(live)) {
      if (k in declared) continue;
      if (schema.writeOnly.has(k)) continue;
      if (k in schema.defaults && deepEqual(v, schema.defaults[k])) continue; // schema default
      if (k in knownDef && deepEqual(v, knownDef[k])) continue; // A4 known default
      if (isAllAwsTags(v)) continue; // A2 aws:* tags (any key)
      if (v === physId) continue; // identity == physical id
      if (isTrivialEmpty(v)) continue; // A1 trivial empty/off
      tiers.undeclared.push(`${logicalId}.${k} (${type}) = ${j(v)}`);
    }
  }

  // report
  const line = (s: string) => console.log('  ' + s);
  console.log(`\n=== cdkrd check: ${stackName} (${region}) ===`);
  section('CLOBBER', []); // pre-deploy only — not in this slice
  section('DECLARED DRIFT', tiers.declared);
  section('UNDECLARED DRIFT (the differentiator)', tiers.undeclared);
  section('READ GAP (declared but not returned by live read — not drift)', tiers.readGap);
  section('UNRESOLVED (declared paths needing GetAtt — skipped, not drift)', tiers.unresolved);
  section('SKIPPED (CC API unsupported / no phys id)', tiers.skipped);
  const drifted = tiers.declared.length + tiers.undeclared.length;
  console.log(
    `\nresult: ${drifted === 0 ? 'CLEAN' : drifted + ' drift(s)'} (declared=${tiers.declared.length} undeclared=${tiers.undeclared.length} readGap=${tiers.readGap.length} unresolved=${tiers.unresolved.length} skipped=${tiers.skipped.length})`
  );
  return drifted === 0 ? 0 : 1;

  function section(title: string, items: string[]) {
    console.log(`\n[${title}] ${items.length}`);
    for (const it of items) line(it);
  }
}
function j(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 200 ? s.slice(0, 200) + '…' : s;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });

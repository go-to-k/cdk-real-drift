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

// A dynamic reference EMBEDDED inside a larger string. CloudFormation also resolves a
// `{{resolve:<service>:…}}` token that appears WITHIN a longer literal (the classic
// connection-string pattern, e.g.
// `"postgres://admin:{{resolve:secretsmanager:MySecret:SecretString:password}}@host:5432/db"`):
// embedded dynamic references in a larger string are an explicitly supported CFn feature,
// resolved at deploy time. So a declared string that merely CONTAINS a well-formed token is
// just as deploy-time-transformed — its final live value is unknowable to cdkrd and it must
// fold to UNRESOLVED exactly like the whole-string case. The anchored isDynamicReference above
// misses this, so the raw token would leak out as a declared value → a false positive on every
// clean deploy that (worse) prints the resolved secret plaintext and, on revert, writes the
// literal `{{resolve:…}}` back into the live resource. Keep the service allow-list + a closing
// `}}` so a malformed/partial fragment (a bare `{{resolve`, or `{{resolve:unknownsvc:x}}`) is
// NOT swallowed — only a genuine, well-formed dynamic reference is muted. The `?` makes the
// scan non-greedy up to the FIRST closing `}}`. A whole-string match is a subset of this, so
// the internal muting sites use this contains-form. See #722.
const CONTAINS_DYNAMIC_REFERENCE_RE = /\{\{resolve:(ssm|ssm-secure|secretsmanager):[\s\S]*?\}\}/;
export function containsDynamicReference(v: string): boolean {
  return CONTAINS_DYNAMIC_REFERENCE_RE.test(v);
}

// Re-check a resolved value that an intrinsic PRODUCED (a Ref-to-parameter value,
// an Fn::FindInMap lookup, an Fn::Select element, an Fn::ImportValue export) for a
// dynamic reference. The literal-string guard at the top of `resolve`
// only sees a `{{resolve:…}}` token that appears DIRECTLY in the template tree; when
// the same token arrives INDIRECTLY as the result of resolving one of these
// intrinsics, that guard never runs, so the raw token would leak out as a declared
// value (a false positive that also prints the secret plaintext and, on revert,
// writes the literal `{{resolve:…}}` back). Fold it to UNRESOLVED here — the same
// post-resolution re-check Fn::Join and Fn::Sub already do on their assembled result.
// Use the contains-form so an EMBEDDED token in a larger produced string is muted too
// (see #722); a whole-string token is a subset of it.
// See #1073 (the indirect siblings of the direct-literal guard #722).
// A produced CONTAINER (a CommaDelimitedList/List<> parameter value split by
// buildResolverContext.toParam, an Fn::FindInMap list value) may carry the token as
// an ELEMENT — a string-only gate would let it through uninspected, the same leak one
// level down. Fail closed on the WHOLE container when ANY string leaf carries a
// token: per-element muting would fabricate a list whose shape differs from live,
// so whole-value muting matches the scalar precedent. See #1331.
function containsDynamicReferenceDeep(v: unknown): boolean {
  if (typeof v === 'string') return containsDynamicReference(v);
  if (Array.isArray(v)) return v.some(containsDynamicReferenceDeep);
  if (v !== null && typeof v === 'object') {
    return Object.values(v).some(containsDynamicReferenceDeep);
  }
  return false;
}
function checkResolvedDynamicRef(r: unknown): unknown {
  return containsDynamicReferenceDeep(r) ? UNRESOLVED : r;
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

// `inCondition` marks resolution that is happening in CONDITION-EVALUATION context
// (a `Conditions`-section body reached via evalCondition, or a nested condition
// operand), as opposed to PROPERTY-VALUE context. It is threaded so a bare single-key
// `{Condition: <name>}` object is honored as the condition-reference intrinsic ONLY in
// condition context — in property position it is literal data (a one-key map named
// `Condition` inside a free-form JSON document), so evaluating it there would corrupt
// the declared value (`{Foo: {Condition: 'IsProd'}}` -> `Foo: false`, an unknown name ->
// UNRESOLVED). See #783.
export function resolve(node: unknown, ctx: ResolverContext, inCondition = false): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(n, ctx, inCondition));
  // A CloudFormation DYNAMIC REFERENCE (`{{resolve:ssm:…}}`,
  // `{{resolve:ssm-secure:…}}`, `{{resolve:secretsmanager:…}}`) is a deploy-time
  // string substitution: CFn replaces it with the live SSM parameter / secret value
  // while creating the resource, so the deployed template still carries the literal
  // `{{resolve:…}}` token but the live resource holds the resolved value (e.g. an
  // RDS MasterUsername declared as `{{resolve:secretsmanager:…:username::}}` reads
  // back as `admin`). cdkrd cannot — and must not — fetch the secret to resolve it,
  // so the declared side is unknowable: mark UNRESOLVED so the path is skipped, the
  // same fail-closed treatment as Fn::GetAtt, never reported as false drift. Use the
  // contains-form so an EMBEDDED token in a larger literal string (a connection string
  // like `"postgres://admin:{{resolve:secretsmanager:…}}@host/db"`) is muted too, not
  // only a whole-string token. See #722.
  if (typeof node === 'string' && containsDynamicReference(node)) return UNRESOLVED;
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0]!;
    const v = obj[k];
    switch (k) {
      case 'Ref':
        return checkResolvedDynamicRef(resolveRef(String(v), ctx));
      case 'Fn::Sub':
        return resolveSub(v, ctx);
      case 'Fn::Base64': {
        // Fn::Base64 returns the base64 encoding of its (String) argument — a pure,
        // deterministic, environment-INDEPENDENT transform (unlike Fn::GetAZs, which
        // is deliberately left unresolved). CDK emits it for EC2 UserData
        // (`{ "Fn::Base64": { "Fn::Sub": "#!/bin/bash …" } }`), which is a readable,
        // mutable property on AWS::EC2::Instance / the LaunchTemplate's
        // LaunchTemplateData — so without resolving it the declared UserData is a blind
        // spot (UNRESOLVED) and out-of-band UserData drift is missed. Resolve the inner
        // first; CFn only accepts a String argument, so a non-string (or unresolved)
        // inner fails closed to UNRESOLVED rather than encoding `[object Object]`.
        const inner = resolve(v, ctx);
        if (typeof inner !== 'string') return UNRESOLVED;
        return Buffer.from(inner, 'utf8').toString('base64');
      }
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
        const [delim, list] = v as [unknown, unknown];
        // CFn requires a LITERAL string delimiter. A non-string delimiter used raw via
        // `parts.join(delim)` would FABRICATE a declared value — `join({Ref:…})` leaks
        // `[object Object]`, `join(0)` splices a bogus "0" — worse than UNRESOLVED. Fail
        // closed rather than mis-resolve.
        if (typeof delim !== 'string') return UNRESOLVED;
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
        // dynamic reference cdkrd cannot resolve — UNRESOLVED, never false drift. The
        // contains-form also catches a token joined into surrounding literal text (a
        // connection string). See #722.
        return containsDynamicReference(joined) ? UNRESOLVED : joined;
      }
      case 'Fn::Select': {
        if (!Array.isArray(v)) return UNRESOLVED;
        const [idxRaw, list] = v as [unknown, unknown];
        const arr = resolve(list, ctx);
        if (!Array.isArray(arr)) return UNRESOLVED;
        // CloudFormation REMOVES a list element whose value resolves to AWS::NoValue,
        // so the list COMPACTS and indices shift BEFORE Fn::Select runs — mirror the
        // compaction Fn::Join already does, else an index after the NoValue slot
        // selects the WRONG element (a fabricated declared value) and an index AT the
        // slot leaks the NOVALUE symbol (pruneNoValue then deletes the whole declared
        // property). See #1329.
        const compacted = arr.filter((x) => x !== NOVALUE);
        // The index may itself be an intrinsic (CFn allows e.g. { Ref: SomeParam } /
        // Fn::FindInMap as the index) — resolve it before coercing. (Number() on the
        // raw UNRESOLVED symbol would throw, so guard it first.)
        const idx = resolve(idxRaw, ctx);
        if (idx === UNRESOLVED) return UNRESOLVED;
        const i = Number(idx);
        // Fail-closed: out-of-range index (or a NaN index) would otherwise yield
        // `undefined` and report false `desired: undefined` drift. The selected
        // element itself being UNRESOLVED also propagates.
        if (!Number.isInteger(i) || i < 0 || i >= compacted.length) return UNRESOLVED;
        const sel = compacted[i];
        return sel === UNRESOLVED ? UNRESOLVED : checkResolvedDynamicRef(sel);
      }
      case 'Fn::FindInMap': {
        if (!Array.isArray(v) || v.length < 3) return UNRESOLVED;
        // YAML 1.1 turns an unquoted numeric-looking map key argument
        // (`!FindInMap [AcctMap, 123456789012, Bucket]` — account-id / port /
        // numeric-version keyed maps) into a JS NUMBER, and `yes`/`no`/`on`/`off`
        // into a boolean. But Mappings keys are ALWAYS strings (object keys
        // stringify; CFn rejects non-string Mappings keys), so a resolved primitive
        // scalar is safe to stringify for both the string-type check and the lookup —
        // otherwise a knowable declared value is silently dropped to UNRESOLVED
        // (missed drift + a permanent `check --strict` red). Only coerce primitive
        // scalars; objects/arrays/UNRESOLVED args stay fail-closed.
        const [mapName, topKey, secondKey] = v.slice(0, 3).map((x) => {
          const r = resolve(x, ctx);
          return typeof r === 'number' || typeof r === 'boolean' ? String(r) : r;
        });
        // All 3 keys must resolve to strings and the path must exist; else fail-closed.
        if (
          typeof mapName !== 'string' ||
          typeof topKey !== 'string' ||
          typeof secondKey !== 'string'
        )
          return UNRESOLVED;
        const val = ctx.mappings?.[mapName]?.[topKey]?.[secondKey];
        if (val !== undefined) return checkResolvedDynamicRef(val);
        // CFn supports an optional 4th argument — { DefaultValue: ... } — returned when
        // the map path is absent. Honor it so a declared default is still compared (else
        // a knowable declared value is silently dropped to UNRESOLVED = missed drift).
        const fourth = v[3];
        if (
          fourth !== null &&
          typeof fourth === 'object' &&
          !Array.isArray(fourth) &&
          'DefaultValue' in fourth
        ) {
          const def = resolve((fourth as Record<string, unknown>).DefaultValue, ctx);
          return def === UNRESOLVED ? UNRESOLVED : checkResolvedDynamicRef(def);
        }
        return UNRESOLVED;
      }
      case 'Fn::Split': {
        if (!Array.isArray(v) || v.length < 2) return UNRESOLVED;
        const delim = v[0];
        const src = resolve(v[1], ctx);
        if (typeof delim !== 'string' || typeof src !== 'string') return UNRESOLVED;
        return src.split(delim);
      }
      case 'Fn::Cidr': {
        // Fn::Cidr [ipBlock, count, cidrBits] is a deterministic pure function: it
        // splits ipBlock (a CIDR like "10.0.0.0/16") into `count` subnets each of size
        // 2^cidrBits addresses (so subnet mask = 32 - cidrBits for IPv4), starting at the
        // ipBlock base and incrementing by 2^cidrBits per subnet. Resolving it lets a
        // declared subnet CidrBlock (`{ "Fn::Select": [n, { "Fn::Cidr": … }] }`) be
        // compared instead of left a blind spot. Fail closed to UNRESOLVED on any
        // unresolved / mistyped / out-of-range arg (IPv6 is not resolved).
        if (!Array.isArray(v) || v.length < 3) return UNRESOLVED;
        const [ipBlock, count, cidrBits] = v.slice(0, 3).map((x) => resolve(x, ctx));
        // Any arg still UNRESOLVED (a first-pass Fn::GetAtt, a missing Fn::ImportValue,
        // an unresolvable Fn::If) is the UNRESOLVED Symbol — Number() on it throws, so
        // guard first, exactly as the Fn::Select case above does for its index.
        if (ipBlock === UNRESOLVED || count === UNRESOLVED || cidrBits === UNRESOLVED) {
          return UNRESOLVED;
        }
        return resolveCidr(ipBlock, count, cidrBits);
      }
      case 'Fn::ImportValue': {
        const name = resolve(v, ctx);
        if (typeof name !== 'string') return UNRESOLVED;
        // Prefetched exports (see loadDesired); absent name -> fail-closed.
        return name in ctx.exports ? checkResolvedDynamicRef(ctx.exports[name]) : UNRESOLVED;
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
        // A bare `{Condition: <name>}` object is the condition-reference intrinsic ONLY
        // when it appears in condition-evaluation context (an operand inside
        // Fn::And/Or/Not, or a Conditions-section body). In PROPERTY position it is
        // literal data — a one-key map that happens to be named `Condition` inside a
        // free-form JSON document — so fall through to the data object-walk below rather
        // than evaluate it (which would corrupt the declared value). See #783.
        if (inCondition) return evalCondition(String(v), ctx);
        break;
      default:
        // Any intrinsic we don't fully resolve → UNRESOLVED, so the declared
        // path is skipped (never reported as false drift).
        if (k.startsWith('Fn::')) return UNRESOLVED;
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [kk, vv] of Object.entries(obj)) out[kk] = resolve(vv, ctx, inCondition);
  return out;
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a === b) return true;
  // CloudFormation evaluates `Fn::Equals` as a STRING comparison. A Number/Boolean
  // template Parameter is carried as a string by buildResolverContext (params are
  // stringified), so `Fn::Equals[{Ref: MaxAZs="2"}, 2]` (literal NUMBER) must be TRUE,
  // and `[{Ref: Enabled="true"}, true]` TRUE — else the WRONG `Fn::If` branch bakes a
  // corrupted declared value into the diff (a phantom FP, or a hidden FN), and this
  // operator is fail-OPEN unlike the rest of the resolver. Coerce string<->number/
  // boolean via exact String() match (CFn does NOT fold "2.0"==2 in Equals, so no
  // numeric-format folding here); genuine inequality still differs.
  const prim = (x: unknown): x is number | boolean =>
    typeof x === 'number' || typeof x === 'boolean';
  if ((typeof a === 'string' && prim(b)) || (typeof b === 'string' && prim(a))) {
    return String(a) === String(b);
  }
  return false;
}

// Evaluate a condition operand to true | false | UNRESOLVED (fail-closed).
function condVal(node: unknown, ctx: ResolverContext): boolean | typeof UNRESOLVED {
  if (node && typeof node === 'object' && 'Condition' in (node as object)) {
    const r = evalCondition(String((node as Record<string, unknown>)['Condition']), ctx);
    return r === UNRESOLVED ? UNRESOLVED : r === true;
  }
  const r = resolve(node, ctx, true);
  if (r === true) return true;
  if (r === false) return false;
  return UNRESOLVED;
}

export function evalCondition(name: string, ctx: ResolverContext): boolean | typeof UNRESOLVED {
  if (ctx.condCache.has(name)) return ctx.condCache.get(name) as boolean | typeof UNRESOLVED;
  // Seed the cache with UNRESOLVED BEFORE recursing: a condition that references
  // itself (directly, or via a cycle A→B→A through a `{Condition: …}` operand) would
  // otherwise recurse forever and hang `cdkrd check`. CloudFormation rejects circular
  // conditions at deploy time, so a DEPLOYED template can't carry one — but a
  // `--pre-deploy` synth template is unvalidated and a hand-rolled `--app` output
  // could. Failing closed to UNRESOLVED on the cycle is the safe direction (the
  // dependent Fn::If branch is then skipped, never mis-evaluated).
  ctx.condCache.set(name, UNRESOLVED);
  const r = resolve(ctx.conditions[name], ctx, true);
  const val = r === true ? true : r === false ? false : UNRESOLVED;
  ctx.condCache.set(name, val);
  return val;
}

// A GetAtt attribute that MIRRORS a declared property of the referenced resource:
// `<resourceType> -> { <getAttAttrName>: <declaredPropertyKey> }`. Such an attribute is
// fully controlled by the template, so its INTENT is the declared property's value, not
// the live value. Resolving it against the live model lets an out-of-band change to the
// referenced resource cascade into PHANTOM drift on every consumer that interpolates the
// attribute into one of its OWN declared properties — e.g. renaming a Cognito
// IdentityPool in the console makes the readOnly `Name` GetAtt resolve to the new name,
// which CDK bakes into each authenticated/unauthenticated Role `Description`
// ("Default … Role for Identity Pool ${IdPool.Name}"), so the Roles falsely report
// declared drift even though their live Description (frozen at create time) never
// changed. Resolving from the declared `IdentityPoolName` instead keeps intent == the
// real (unchanged) value. Curated, not derived: only listed (type, attr) pairs whose
// attribute is genuinely a declared property — a runtime-only attribute (ARN, Id,
// Endpoint) has no declared source and must stay live.
const GETATT_DECLARED_PROPERTY: Record<string, Record<string, string>> = {
  'AWS::Cognito::IdentityPool': { Name: 'IdentityPoolName' },
};

// Resolve Fn::GetAtt against the referenced resource's LIVE model (ctx.liveAttrs),
// NOT a guessed ARN format. `[LogicalId, AttrName]`; AttrName may be dotted
// (e.g. "Endpoint.Address"). Returns the live attribute value, or UNRESOLVED
// (fail-closed) when the target wasn't read or the attribute is absent — so a
// missing live read never fabricates a value or reports false drift. Comparing a
// GetAtt against the target's CURRENT attribute is still real drift detection on
// the CONSUMING resource (does it actually point at that attribute's value?).
export function resolveGetAtt(v: unknown, ctx: ResolverContext): unknown {
  // Fn::GetAtt has a long-form STRING argument in JSON — `{"Fn::GetAtt": "Bucket.Arn"}`
  // — as well as the array form `[LogicalId, AttrName]` (yaml-cfn.ts already handles the
  // YAML SHORT form `!GetAtt`). Attribute names can contain dots (e.g. `Outputs.X`), so
  // split the string on the FIRST dot only into `[logicalId, attrPath]`; a no-dot string
  // has no attribute -> UNRESOLVED. Then fall through to the array-form logic below.
  if (typeof v === 'string') {
    const dot = v.indexOf('.');
    if (dot < 0) return UNRESOLVED;
    v = [v.slice(0, dot), v.slice(dot + 1)];
  }
  if (!Array.isArray(v) || v.length < 2) return UNRESOLVED;
  const logicalId = String(v[0]);
  const attr = String(v[1]);
  // When the attribute mirrors a declared property, prefer the template-declared value
  // (intent) over the live value, so out-of-band drift on the referenced resource does
  // not cascade into phantom drift on consumers. Fall through to live when the declared
  // property is absent or itself does not statically resolve to a scalar.
  const type = ctx.typeOf?.[logicalId];
  // CDK `crossRegionReferences: true` pattern: a `Custom::CrossRegionExportReader`
  // materializes each imported value as an SSM parameter `/cdk/exports/<name>` in the
  // consumer region, and the consumer property is `{ Fn::GetAtt: [<Reader>, "/cdk/exports/<name>"] }`.
  // The reader has no live model (router.ts short-circuits Custom::* to skipped), so this
  // GetAtt would otherwise be permanently UNRESOLVED — leaving an out-of-band cert swap
  // invisible. Resolve it from the prefetched SSM map (template-adapter.ts). Gate on the
  // reader Type when known; else on the unambiguous `/cdk/exports/` attribute shape (only
  // this pattern produces a GetAtt attribute starting with a slash). Missing from the map
  // (unread/unresolvable) falls through to UNRESOLVED as before — so ordinary GetAtts and a
  // fail-closed prefetch are unaffected.
  if (
    attr.startsWith('/cdk/exports/') &&
    (type === undefined || type === 'Custom::CrossRegionExportReader')
  ) {
    const val = ctx.crossRegionExports?.[attr];
    if (typeof val === 'string') return val;
    // Reader GetAtt but no prefetched value → fail closed. Do not fall through to the
    // live-model path below (a reader has no live model, so it would also be UNRESOLVED).
    return UNRESOLVED;
  }
  const declaredKey = type ? GETATT_DECLARED_PROPERTY[type]?.[attr] : undefined;
  if (declaredKey !== undefined) {
    const rawProps = ctx.declaredRawProps?.[logicalId];
    if (rawProps && declaredKey in rawProps) {
      const declared = resolve(rawProps[declaredKey], ctx);
      if (declared !== UNRESOLVED && declared !== NOVALUE && isScalarInterpolant(declared))
        return declared;
    }
  }
  const model = ctx.liveAttrs[logicalId];
  if (!model) return UNRESOLVED;
  const segs = attr.split('.');
  // A parent stack consuming a NESTED stack's output uses
  // `Fn::GetAtt [Nested, "Outputs.<OutputKey>"]` (and the `Fn::Sub`
  // `${Nested.Outputs.<OutputKey>}` form). The live Cloud Control model for
  // `AWS::CloudFormation::Stack` stores `Outputs` as an ARRAY of
  // `{ OutputKey, OutputValue }` objects (readOnly), so descending
  // `["Outputs", "<OutputKey>"]` through getPath indexes the array by the string
  // key -> undefined -> permanently UNRESOLVED. Build an OutputKey -> OutputValue
  // map and resolve the key against it (detection-preserving: a changed output
  // still differs). Confined to AWS::CloudFormation::Stack so getPath's general
  // array behavior is unchanged for every other type.
  if (
    ctx.typeOf?.[logicalId] === 'AWS::CloudFormation::Stack' &&
    segs.length >= 2 &&
    segs[0] === 'Outputs'
  ) {
    const outputs = model['Outputs'];
    if (Array.isArray(outputs)) {
      const key = segs[1];
      const entry = outputs.find(
        (o): o is Record<string, unknown> =>
          o !== null && typeof o === 'object' && (o as Record<string, unknown>)['OutputKey'] === key
      );
      if (entry === undefined) return UNRESOLVED;
      // Descend any remaining path segments (rare, but keep parity with getPath).
      const rest = segs.slice(2);
      const got =
        rest.length === 0 ? entry['OutputValue'] : getPath(entry, ['OutputValue', ...rest]);
      return got === undefined ? UNRESOLVED : got;
    }
  }
  const got = getPath(model, segs);
  return got === undefined ? UNRESOLVED : got;
}

// Resolve Fn::Cidr [ipBlock, count, cidrBits] for IPv4. Returns the array of
// "<ip>/<maskLen>" CIDR strings, or UNRESOLVED (fail-closed) when an arg is the wrong
// type, the ipBlock is not a valid IPv4 CIDR, or `count` subnets do not fit in the
// block. `cidrBits` is the number of subnet bits from the RIGHT: each subnet spans
// 2^cidrBits addresses, its mask length is 32 - cidrBits. IPv6 (a "::"-form ipBlock)
// is not resolved.
function resolveCidr(ipBlock: unknown, count: unknown, cidrBits: unknown): unknown {
  if (typeof ipBlock !== 'string') return UNRESOLVED;
  // count / cidrBits may arrive as numbers or numeric strings (a resolved Ref); coerce
  // and demand exact integers.
  const cnt = Number(count);
  const bits = Number(cidrBits);
  if (!Number.isInteger(cnt) || cnt <= 0) return UNRESOLVED;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return UNRESOLVED;
  // IPv6 not supported (fail closed): an IPv6 CIDR carries "::" / hex groups.
  if (ipBlock.includes(':')) return UNRESOLVED;
  const slash = ipBlock.indexOf('/');
  if (slash < 0) return UNRESOLVED;
  const ipPart = ipBlock.slice(0, slash);
  const prefix = Number(ipBlock.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return UNRESOLVED;
  const base = ipv4ToInt(ipPart);
  if (base === undefined) return UNRESOLVED;
  const maskLen = 32 - bits;
  // The subnet mask (maskLen) must be no coarser than the block's own prefix, else the
  // requested subnets are larger than the block itself.
  if (maskLen < prefix) return UNRESOLVED;
  const step = 2 ** bits; // addresses per subnet
  const blockSize = 2 ** (32 - prefix); // addresses in the whole block
  // Fail closed on a non-canonical block: if the ipBlock carries host bits (its base is not
  // the network address for its own prefix) we cannot know which address AWS canonicalizes
  // to, and generating from the host address both starts at the wrong place and can run past
  // the block. AWS always stores the network address, so a real Fn::Cidr input is aligned.
  if (base % blockSize !== 0) return UNRESOLVED;
  // The base is the block's network address; subnets tile from there.
  // `count` subnets of `step` addresses each must fit inside the block.
  if (cnt * step > blockSize) return UNRESOLVED;
  const out: string[] = [];
  for (let i = 0; i < cnt; i++) {
    const addr = base + i * step;
    if (addr > 0xffffffff) return UNRESOLVED;
    out.push(`${intToIpv4(addr)}/${maskLen}`);
  }
  return out;
}

// Parse a dotted-quad IPv4 string to a 32-bit unsigned integer, or undefined if malformed.
function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const octet = Number(p);
    if (octet < 0 || octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

// Format a 32-bit unsigned integer as a dotted-quad IPv4 string.
function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
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
  else if (Array.isArray(v)) {
    tmpl = v[0] as string;
    vars = (v[1] as Record<string, unknown>) ?? {};
  } else {
    // CFn Fn::Sub takes only a String or a [String, Map]. Any other shape
    // (a number / null / bare object) is malformed — fail closed rather than
    // let a non-string `tmpl` throw on `.replace` below.
    return UNRESOLVED;
  }
  // The template string must be a genuine string: `{"Fn::Sub": []}` /
  // `{"Fn::Sub": [5, {}]}` produce a non-string `tmpl` that would throw on
  // `.replace`. Fail closed like every other branch.
  if (typeof tmpl !== 'string') return UNRESOLVED;
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
      // A non-scalar resolution can't be interpolated: an object GetAtt attribute
      // (`${DB.Endpoint}` = {Address,Port}) would leak `[object Object]`, an array
      // (a `CommaDelimitedList` Ref / `Fn::Split` value) the JS comma-join — either a
      // bogus declared value the diff then reports as drift on a clean stack. Fail
      // closed, mirroring the `vars` branch above (isScalarInterpolant is also false
      // for the UNRESOLVED / NOVALUE symbols, so it subsumes that earlier check).
      if (!isScalarInterpolant(r)) {
        unresolved = true;
        return '';
      }
      return String(r);
    }
    const r = resolveRef(ref, ctx);
    if (!isScalarInterpolant(r)) {
      unresolved = true;
      return '';
    }
    return String(r);
  });
  if (unresolved) return UNRESOLVED;
  // an Fn::Sub may also ASSEMBLE a dynamic reference (`{{resolve:…}}`) — the
  // assembled token is deploy-time-resolved and unknowable, so UNRESOLVED. The
  // contains-form also catches a token embedded in surrounding literal text of the
  // substituted string (a connection string). See #722.
  return containsDynamicReference(out) ? UNRESOLVED : out;
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

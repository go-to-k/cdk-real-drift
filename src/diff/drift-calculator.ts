// Copied from cdkd src/analyzer/drift-calculator.ts (pure function, no deps).
// Walks keys present in `stateProperties` (the desired side) and reports where
// `awsProperties` (actual) differs. Nested objects recurse with dotted paths;
// arrays compare element-wise as a single parent-path drift.
export interface PropertyDrift {
  path: string;
  stateValue: unknown;
  awsValue: unknown;
}

export function calculateResourceDrift(
  stateProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  options?: { ignorePaths?: readonly string[] }
): PropertyDrift[] {
  const drifts: PropertyDrift[] = [];
  const ignore = options?.ignorePaths ?? [];
  for (const key of Object.keys(stateProperties)) {
    if (isIgnoredPath(key, ignore)) continue;
    diffAt(key, stateProperties[key], awsProperties[key], drifts, ignore);
  }
  return drifts;
}

function isIgnoredPath(path: string, ignorePaths: readonly string[]): boolean {
  for (const entry of ignorePaths) {
    if (path === entry || path.startsWith(`${entry}.`)) return true;
  }
  return false;
}

function diffAt(
  path: string,
  sv: unknown,
  av: unknown,
  out: PropertyDrift[],
  ignorePaths: readonly string[]
): void {
  if (deepEqual(sv, av)) return;
  if (isPlainObject(sv) && isPlainObject(av) && !Array.isArray(sv) && !Array.isArray(av)) {
    // A free-form map (DockerLabels, Tags, Glue Parameters, …) can hold USER keys that
    // contain the path grammar's separators — a Docker label `com.example.x`, a tag key
    // with a `.`, a key with `[`/`]`. Descending would build a child path like
    // `DockerLabels.com.example.x` that every downstream consumer (toPointer for the
    // revert JSON-pointer, the baseline `topSegment`, the ignore-rule glob) RE-SPLITS on
    // `.`/`[`, landing on the WRONG location — a misdirected revert write and a silently
    // ineffective ignore/baseline rule. When any key would corrupt the path, don't
    // descend: emit the whole map at the current (safe) path. The revert then rewrites
    // the map as a unit (correct) and the finding path carries no ambiguous segment.
    if (hasPathUnsafeKey(sv) || hasPathUnsafeKey(av)) {
      out.push({ path, stateValue: sv, awsValue: av });
      return;
    }
    // Subset semantics: only walk keys present in the desired (state) side, so an
    // AWS-added nested key the template never set is not a DECLARED-side change here.
    // (R96: such live-only nested keys are instead caught by classify's
    // `collectNestedUndeclared` as nested UNDECLARED findings — folded, baseline-able.)
    for (const key of Object.keys(sv)) {
      const childPath = `${path}.${key}`;
      if (isIgnoredPath(childPath, ignorePaths)) continue;
      diffAt(childPath, sv[key], (av as Record<string, unknown>)[key], out, ignorePaths);
    }
    return;
  }
  // Same-length arrays of objects: compare element-wise with the same subset
  // semantics, so AWS enriching a declared array element with extra sub-fields
  // (e.g. S3 BucketEncryption.BucketKeyEnabled) is not false drift. A length
  // change is a genuine drift and falls through to the push below.
  if (
    Array.isArray(sv) &&
    Array.isArray(av) &&
    sv.length === av.length &&
    sv.every(isPlainObject) &&
    av.every(isPlainObject)
  ) {
    for (let i = 0; i < sv.length; i++) diffAt(`${path}.${i}`, sv[i], av[i], out, ignorePaths);
    return;
  }
  out.push({ path, stateValue: sv, awsValue: av });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.hasOwn(bo, key)) return false;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A key that contains the path grammar's separators (`.`, `[`, `]`). Descending into
// such a key would produce a finding path that downstream consumers re-split into the
// wrong location — so an object holding one is emitted whole at its parent path.
const PATH_UNSAFE_KEY = /[.[\]]/;
function hasPathUnsafeKey(o: Record<string, unknown>): boolean {
  return Object.keys(o).some((k) => PATH_UNSAFE_KEY.test(k));
}

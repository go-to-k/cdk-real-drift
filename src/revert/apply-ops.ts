// Apply RFC6902-ish add/remove ops (as produced by the revert plan) onto a copy
// of a resource model, by JSON pointer. Used by the SDK writers to reconstruct
// the DESIRED full property value before a whole-property SDK write (e.g. set the
// full bucket policy), so sub-path drifts revert correctly too.
import { deepEqual } from '../diff/drift-calculator.js';
import type { PatchOp } from './plan.js';

function unescape(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerSegs(path: string): string[] {
  return path.split('/').slice(1).map(unescape);
}

// #805: a revert op that a whole-document SDK writer applies (PutBucketPolicy /
// PutRolePolicy / CreatePolicyVersion / UpdateWebACL, …) carries a numeric index
// (`…/Statement/1/Resource`, `…/Rules/1/…`) computed against the CHECK-time,
// canonically-SORTED model. The writer re-reads the live model at apply time and
// re-canonicalizes it so the index still ALIGNS BY ORDER — but if a statement/rule
// was added or removed while the user sat on the confirm prompt (#760's mutation
// window), the sorted FRESH array puts a DIFFERENT element at that index. The
// whole-document PUT would then overwrite an innocent (security-relevant) element
// AND leave the real drift unreverted — the SDK-path twin of the CC stale-index
// window #762 wrongly assumed the SDK re-read closed (the re-read fixes ORDER, not
// index FRESHNESS). Every op carries `prior` (the check-time live value at its
// path, = f.actual, set by plan.ts revertOp); before a whole-document write, verify
// the FRESH model still holds `prior` at each op's path. Any mismatch means the
// array shifted under the plan — ABORT rather than wrong-write. The model passed
// here MUST already be canonicalized the same way the op index was (the caller
// aligns it), so a stable model compares equal.
export class StaleRevertModelError extends Error {
  readonly pointerPath: string;
  constructor(pointerPath: string) {
    super(
      `revert aborted: the live value at ${pointerPath} changed since drift was detected ` +
        `(an element in the same array was added or removed) — re-run \`check\` and revert again`
    );
    this.name = 'StaleRevertModelError';
    this.pointerPath = pointerPath;
  }
}

export function assertPriorUnchanged(
  model: Record<string, unknown>,
  ops: readonly PatchOp[]
): void {
  for (const op of ops) {
    // `prior` is absent for a re-add of a live-REMOVED value (nothing at the path
    // to protect) and for contract plumbing ops — nothing to verify in either case.
    if (op.prior === undefined) continue;
    if (!deepEqual(getAt(model, pointerSegs(op.path)), op.prior)) {
      throw new StaleRevertModelError(op.path);
    }
  }
}

function getAt(root: unknown, segs: string[]): unknown {
  let node: unknown = root;
  for (const seg of segs) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export function applyOps(
  model: Record<string, unknown>,
  ops: readonly PatchOp[]
): Record<string, unknown> {
  const out = structuredClone(model);
  for (const op of ops) {
    const segs = pointerSegs(op.path);
    if (op.op === 'add') setAt(out, segs, op.value);
    else removeAt(out, segs);
  }
  return out;
}

function setAt(root: unknown, segs: string[], value: unknown): void {
  let node = root as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]!;
    if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]!] = value;
}

function removeAt(root: unknown, segs: string[]): void {
  let node = root as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]!;
    if (node[k] === null || typeof node[k] !== 'object') return;
    node = node[k] as Record<string, unknown>;
  }
  delete node[segs[segs.length - 1]!];
}

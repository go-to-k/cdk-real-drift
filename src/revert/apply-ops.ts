// Apply RFC6902-ish add/remove ops (as produced by the revert plan) onto a copy
// of a resource model, by JSON pointer. Used by the SDK writers to reconstruct
// the DESIRED full property value before a whole-property SDK write (e.g. set the
// full bucket policy), so sub-path drifts revert correctly too.
import type { PatchOp } from './plan.js';

function unescape(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function applyOps(
  model: Record<string, unknown>,
  ops: readonly PatchOp[]
): Record<string, unknown> {
  const out = structuredClone(model);
  for (const op of ops) {
    const segs = op.path.split('/').slice(1).map(unescape);
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

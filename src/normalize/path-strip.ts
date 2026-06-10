// Delete dotted property paths (with '*' wildcard for array elements / any key)
// from an object IN PLACE. Used to strip schema readOnly/writeOnly paths at any
// depth, e.g. "LifecycleConfiguration.Rules.*.Transition".
export function deepStripPaths(obj: Record<string, unknown>, paths: readonly string[]): void {
  for (const p of paths) stripPath(obj, p.split("."));
}

function stripPath(node: unknown, segs: string[]): void {
  if (node === null || typeof node !== "object") return;
  const [head, ...rest] = segs;
  const container = node as Record<string, unknown>;
  const keys = head === "*" ? (Array.isArray(node) ? node.map((_, i) => String(i)) : Object.keys(container)) : [head];
  for (const k of keys) {
    if (rest.length === 0) {
      if (!Array.isArray(node)) delete container[k]; // deleting array elements by index left as no-op (rare for a leaf '*')
    } else {
      stripPath(container[k], rest);
    }
  }
}

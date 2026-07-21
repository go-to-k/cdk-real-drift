// #683 — CloudFormation STACK-level tag helpers.

// The set of Tag KEYS a resource DECLARES on its top-level `Tags` list (a `{Key,Value}[]`)
// or inside a declared `TagSpecifications` wrapper (the EC2 create-time input shape —
// `[{ResourceType, Tags: {Key,Value}[]}]`). Used to protect a declared tag key from the
// stack-tag subtraction below: a key the resource itself declares is real intent and must
// stay in the live model so the declared loop compares it (a value change on it still
// surfaces).
export const declaredTagKeys = (declared: unknown): ReadonlySet<string> => {
  const out = new Set<string>();
  const collect = (tags: unknown) => {
    if (!Array.isArray(tags)) return;
    for (const t of tags) {
      const k = (t as Record<string, unknown> | null | undefined)?.Key;
      if (typeof k === 'string') out.add(k);
    }
  };
  const d = declared as Record<string, unknown> | null | undefined;
  collect(d?.Tags);
  const specs = d?.TagSpecifications;
  if (Array.isArray(specs)) {
    for (const spec of specs) collect((spec as Record<string, unknown> | null | undefined)?.Tags);
  }
  return out;
};

// CloudFormation STACK-level tags (`cdk deploy --tags k=v`, `create-stack --tags`, StackSets,
// Service Catalog) are propagated by CFN onto every taggable resource WITHOUT ever appearing in
// the template. `stripAwsTagsDeep` only removes `aws:*` tags, so these propagated USER tags
// surface on a clean deploy — a declared-tier tag FP on resources that declare Tags (their
// declared list is a strict subset of the live list) and a first-run undeclared `Tags` FP on
// resources that declare none. Subtract a propagated stack tag from the resource's top-level
// live `Tags` list UNLESS the resource itself declares that key (declared → real intent,
// compared normally). Only an EXACT {Key,Value} match to a stack tag is dropped, so a
// resource-level tag that merely shares a key with a stack tag but has a different value is
// preserved (and its divergence still surfaces). Scoped to the standard top-level `Tags` list
// (where CFN propagates them) plus the EC2 `TagSpecifications` input-wrapper echo (below);
// map-shaped / differently-named tag properties are out of scope (#862).
//
// TagSpecifications: some EC2 registry handlers (CapacityReservation) echo the create-time
// `TagSpecifications` INPUT wrapper back on read, with the propagated stack tags inside each
// spec's `Tags` — an undeclared first-run FP on every stack-tagged deploy (live,
// zerocorpus-hunt 2026-07-21; the `aws:*` members are already stripped by stripAwsTagsDeep).
// Apply the same per-tag subtraction inside each spec, drop a spec whose Tags empty, and drop
// the wrapper itself when every spec empties. A genuinely out-of-band tag (no stack-tag match)
// survives and still surfaces.
export const subtractPropagatedStackTags = (
  live: Record<string, unknown>,
  stackTags: Record<string, string>,
  declaredKeys: ReadonlySet<string>
): Record<string, unknown> => {
  if (Object.keys(stackTags).length === 0) return live;
  const keepTag = (t: unknown): boolean => {
    if (!t || typeof t !== 'object') return true;
    const key = (t as Record<string, unknown>).Key;
    const value = (t as Record<string, unknown>).Value;
    if (typeof key !== 'string') return true;
    if (declaredKeys.has(key)) return true; // declared intent — keep it, compared normally
    return !(key in stackTags && stackTags[key] === value); // drop the propagated stack tag
  };
  let out = live;
  const tags = live.Tags;
  if (Array.isArray(tags)) {
    const filtered = tags.filter(keepTag);
    if (filtered.length !== tags.length) out = { ...out, Tags: filtered };
  }
  const specs = out.TagSpecifications;
  if (Array.isArray(specs)) {
    let changed = false;
    const filteredSpecs = specs
      .map((spec) => {
        const specTags = (spec as Record<string, unknown> | null | undefined)?.Tags;
        if (!Array.isArray(specTags)) return spec;
        const filtered = specTags.filter(keepTag);
        if (filtered.length === specTags.length) return spec;
        changed = true;
        return { ...(spec as Record<string, unknown>), Tags: filtered };
      })
      .filter((spec) => {
        const specTags = (spec as Record<string, unknown> | null | undefined)?.Tags;
        return !(Array.isArray(specTags) && specTags.length === 0);
      });
    if (changed || filteredSpecs.length !== specs.length) {
      out = { ...out };
      if (filteredSpecs.length === 0) delete out.TagSpecifications;
      else out.TagSpecifications = filteredSpecs;
    }
  }
  return out;
};

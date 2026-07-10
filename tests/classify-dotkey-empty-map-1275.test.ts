// #1275 — a path-unsafe-key (dotted) map DECLARED as an explicit empty `{}` was double-reported:
// the declared whole-map compare owns it, but the undeclared nested descent ALSO emitted it whole
// (the #1249 guard fired on zero-length, not genuine absence). Assert a declared-empty dot-key map
// with a live-only `projection.*` key surfaces ONCE (declared), never a duplicate undeclared; and
// that a map with NO declared twin still surfaces (live-only detection preserved).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Tbl',
  resourceType: 'AWS::Glue::Table',
  physicalId: 'db|t',
  declared,
});

describe('#1275 dot-key map declared as explicit empty {} does not double-report', () => {
  it('emits the declared-empty Parameters ONCE (declared), no duplicate undeclared', () => {
    const res = mk({ Name: 't', Parameters: {} });
    const f = classifyResource(
      res,
      { Name: 't', Parameters: { 'projection.enabled': 'true' } },
      emptySchema
    );
    expect(tier(f, 'declared')).toContain('Parameters');
    expect(tier(f, 'undeclared')).not.toContain('Parameters');
  });

  it('still surfaces a wholly-undeclared dot-key map (live-only detection preserved)', () => {
    // Parameters NOT declared at all, present live with a dot-key: the top-level undeclared loop
    // owns it and emits it whole as undeclared — the change must not suppress genuine live-only maps.
    const res = mk({ Name: 't' });
    const f = classifyResource(
      res,
      { Name: 't', Parameters: { 'projection.enabled': 'true' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('Parameters');
    expect(tier(f, 'declared')).not.toContain('Parameters');
  });
});

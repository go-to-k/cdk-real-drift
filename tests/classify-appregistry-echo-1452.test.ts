// #1452 — a ServiceCatalogAppRegistry AttributeGroupAssociation declares `Application` /
// `AttributeGroup` by NAME (the schema documents both as "the name or the id"), but Cloud Control
// echoes back the resource IDs — so a fresh, un-mutated deploy reports both as a permanent
// [CFn-Declared Drift] that `record` cannot accept. classify rewrites the declared name to the id
// derived from the association's OWN composite physical id (`<applicationArn>|<attributeGroupArn>`),
// gated on the live value equalling the derived id: a match folds the alias echo, a mismatch surfaces.
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

const TYPE = 'AWS::ServiceCatalogAppRegistry::AttributeGroupAssociation';
const APP_ID = '0cpp0l6w1qdcdslh6bdgbe94gp';
const ATTR_ID = '08xz6krei60dtgplip3m80imid';
const PHYS =
  `arn:aws:servicecatalog:us-east-1:123456789012:/applications/${APP_ID}` +
  `|arn:aws:servicecatalog:us-east-1:123456789012:/attribute-groups/${ATTR_ID}`;

const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'AppRegAttrAssoc',
  resourceType: TYPE,
  physicalId: PHYS,
  declared,
});

describe('#1452 AppRegistry AttributeGroupAssociation name→id alias echo', () => {
  it('folds the declared-name vs live-id echo on a clean deploy (no declared drift)', () => {
    const res = mk({ Application: 'cdkrd-hunt-app', AttributeGroup: 'cdkrd-hunt-attrs' });
    const f = classifyResource(
      res,
      {
        Application: APP_ID,
        AttributeGroup: ATTR_ID,
        ApplicationArn: `arn:aws:servicecatalog:us-east-1:123456789012:/applications/${APP_ID}`,
        AttributeGroupArn: `arn:aws:servicecatalog:us-east-1:123456789012:/attribute-groups/${ATTR_ID}`,
      },
      emptySchema
    );
    expect(tier(f, 'declared')).not.toContain('Application');
    expect(tier(f, 'declared')).not.toContain('AttributeGroup');
  });

  it('folds even when the template declares the id directly (declared == live)', () => {
    const res = mk({ Application: APP_ID, AttributeGroup: ATTR_ID });
    const f = classifyResource(res, { Application: APP_ID, AttributeGroup: ATTR_ID }, emptySchema);
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('surfaces when the live id does NOT match the physical-id-derived id (fail-closed)', () => {
    const res = mk({ Application: 'cdkrd-hunt-app', AttributeGroup: 'cdkrd-hunt-attrs' });
    // live Application echoes an id that is NOT the trailing segment of the physical-id ARN —
    // the derivation cannot confirm the echo, so the declared name is left to surface.
    const f = classifyResource(
      res,
      { Application: 'some-other-id', AttributeGroup: ATTR_ID },
      emptySchema
    );
    expect(tier(f, 'declared')).toContain('Application');
    expect(tier(f, 'declared')).not.toContain('AttributeGroup');
  });
});

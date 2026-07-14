// #1605 — a dedicated-master OpenSearch domain (DedicatedMasterEnabled=true, count
// undeclared) reads back the documented default DedicatedMasterCount=3 and first-run
// FP'd, live-proven on os-variants2-min (us-east-1, 2026-07-14). Tier-1 nested pin,
// equality-gated: an out-of-band master scale to 5 still surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { Finding, SchemaInfo } from '../src/types.js';

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

const tier = (findings: Finding[], t: string) =>
  findings
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const declared = {
  ClusterConfig: {
    InstanceType: 't3.small.search',
    InstanceCount: 2,
    ZoneAwarenessEnabled: true,
    DedicatedMasterEnabled: true,
    DedicatedMasterType: 't3.small.search',
  },
};

const mk = (count: number) =>
  classifyResource(
    {
      logicalId: 'HuntOsDedMaster',
      resourceType: 'AWS::OpenSearchService::Domain',
      physicalId: 'huntosded',
      declared,
    },
    {
      ClusterConfig: { ...declared.ClusterConfig, DedicatedMasterCount: count },
    },
    emptySchema
  );

describe('#1605 dedicated-master count default fold', () => {
  it('the undeclared 3-master default folds to atDefault', () => {
    const f = mk(3);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('ClusterConfig.DedicatedMasterCount');
  });

  it('an out-of-band master scale to 5 still surfaces', () => {
    expect(tier(mk(5), 'undeclared')).toEqual(['ClusterConfig.DedicatedMasterCount']);
  });
});

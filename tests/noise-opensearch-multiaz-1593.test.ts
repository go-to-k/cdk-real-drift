// #1593 — minimal Multi-AZ OpenSearch domain first-run FPs, live-proven on
// opensearch-multiaz-min (us-east-1, 2026-07-14). Four creation defaults fold:
//   * DomainEndpointOptions — whole-object era ONE_OF (TLS policy default moved
//     from Policy-Min-TLS-1-0-2019-07 to -1-2-; both trios fold, any leaf flip
//     — an EnforceHTTPS enable, a custom endpoint — surfaces).
//   * ClusterConfig.ZoneAwarenessConfig {AvailabilityZoneCount:2} — the value a
//     zone-aware domain materializes when no explicit config is declared.
//   * EBSOptions.VolumeType — era ONE_OF gp3 (current) / gp2 (legacy).
//   * EngineVersion — value-independent (AWS assigns the moving GA version).
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
  },
  EBSOptions: { EBSEnabled: true, VolumeSize: 10 },
};

const mk = (live: Record<string, unknown>) =>
  classifyResource(
    {
      logicalId: 'HuntOsMultiAz',
      resourceType: 'AWS::OpenSearchService::Domain',
      physicalId: 'huntos',
      declared,
    },
    {
      ClusterConfig: {
        InstanceType: 't3.small.search',
        InstanceCount: 2,
        ZoneAwarenessEnabled: true,
        ...(live.ZoneAwarenessConfig ? { ZoneAwarenessConfig: live.ZoneAwarenessConfig } : {}),
      },
      EBSOptions: {
        EBSEnabled: true,
        VolumeSize: 10,
        ...(live.VolumeType ? { VolumeType: live.VolumeType } : {}),
      },
      ...(live.DomainEndpointOptions !== undefined
        ? { DomainEndpointOptions: live.DomainEndpointOptions }
        : {}),
      ...(live.EngineVersion !== undefined ? { EngineVersion: live.EngineVersion } : {}),
    },
    emptySchema
  );

describe('#1593 Multi-AZ OpenSearch first-run folds', () => {
  it('the live-proven creation-default quartet folds with zero potential drift', () => {
    const f = mk({
      DomainEndpointOptions: {
        CustomEndpointEnabled: false,
        EnforceHTTPS: false,
        TLSSecurityPolicy: 'Policy-Min-TLS-1-2-2019-07',
      },
      EngineVersion: 'OpenSearch_3.5',
      ZoneAwarenessConfig: { AvailabilityZoneCount: 2 },
      VolumeType: 'gp3',
    });
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('the legacy-era variants (TLS-1-0 policy, gp2 volume) also fold', () => {
    const f = mk({
      DomainEndpointOptions: {
        CustomEndpointEnabled: false,
        EnforceHTTPS: false,
        TLSSecurityPolicy: 'Policy-Min-TLS-1-0-2019-07',
      },
      VolumeType: 'gp2',
    });
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('detection kept: an endpoint-options leaf flip / 3-AZ move / third volume type surface', () => {
    expect(
      tier(
        mk({
          DomainEndpointOptions: {
            CustomEndpointEnabled: false,
            EnforceHTTPS: true,
            TLSSecurityPolicy: 'Policy-Min-TLS-1-2-2019-07',
          },
        }),
        'undeclared'
      )
    ).toEqual(['DomainEndpointOptions']);
    expect(tier(mk({ ZoneAwarenessConfig: { AvailabilityZoneCount: 3 } }), 'undeclared')).toEqual([
      'ClusterConfig.ZoneAwarenessConfig',
    ]);
    expect(tier(mk({ VolumeType: 'io1' }), 'undeclared')).toEqual(['EBSOptions.VolumeType']);
  });

  it('EngineVersion folds value-independent whatever GA version AWS assigns', () => {
    expect(tier(mk({ EngineVersion: 'OpenSearch_9.9' }), 'undeclared')).toEqual([]);
  });
});

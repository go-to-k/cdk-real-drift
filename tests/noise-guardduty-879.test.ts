// #879: GuardDuty::Detector first-run fold gaps mined from a clean, un-mutated LIVE deploy
// (a fresh `Enable: true`-only detector, stack CdkrdHuntUGd). Three undeclared top-level
// properties surfaced as [Potential Drift] on a first `check`:
//   FindingPublishingFrequency -> tier-1 KNOWN_DEFAULTS constant "SIX_HOURS" (a user lowering
//     it out of band still surfaces).
//   DataSources -> tier-1 whole-object KNOWN_DEFAULTS default (recursively subset-tolerant, so
//     AWS enrichment is tolerated; disabling any leaf re-surfaces).
//   Features -> tier-3 VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS (AWS EXTENDS the list over
//     time, so a pinned constant rots; the property is undeclared, so any value AWS returns
//     is its default, not user intent).
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#879 GuardDuty::Detector undeclared first-run defaults', () => {
  const res: DesiredResource = {
    logicalId: 'Detector',
    resourceType: 'AWS::GuardDuty::Detector',
    physicalId: '1fbe7ac257dc491d9992398365731fc9',
    declared: { Enable: true },
  };
  // The full new-detector default DataSources object (live-harvested).
  const defaultDataSources = {
    MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: true } },
    S3Logs: { Enable: true },
    Kubernetes: { AuditLogs: { Enable: true } },
  };
  // The full new-detector Features list (live-harvested), including a future-ish name.
  const defaultFeatures = [
    { Status: 'DISABLED', Name: 'AI_ANALYST' },
    { Status: 'ENABLED', Name: 'CLOUD_TRAIL' },
    { Status: 'ENABLED', Name: 'DNS_LOGS' },
    { Status: 'ENABLED', Name: 'EBS_MALWARE_PROTECTION' },
    { Status: 'ENABLED', Name: 'S3_DATA_EVENTS' },
  ];
  const cleanLive = {
    Enable: true,
    FindingPublishingFrequency: 'SIX_HOURS',
    DataSources: defaultDataSources,
    Features: defaultFeatures,
  };

  it('produces ZERO potential drift on a clean, un-mutated detector', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds FindingPublishingFrequency=SIX_HOURS to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('FindingPublishingFrequency');
    expect(pathsByTier(f, 'undeclared')).not.toContain('FindingPublishingFrequency');
  });

  it('folds the whole-object DataSources default to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('DataSources');
    expect(pathsByTier(f, 'undeclared')).not.toContain('DataSources');
  });

  it('folds DataSources when the live echo carries FEWER sub-keys than the pinned default', () => {
    // matchesKnownDefault is recursively subset-tolerant: an older/leaner live echo that
    // omits a sub-key the fuller pinned default lists still folds (the default is the
    // superset). Here the live model omits the Kubernetes branch entirely.
    const leaner = {
      ...cleanLive,
      DataSources: {
        MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: true } },
        S3Logs: { Enable: true },
      },
    };
    const f = classifyResource(res, leaner, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('DataSources');
    expect(pathsByTier(f, 'undeclared')).not.toContain('DataSources');
  });

  it('#1092: folds the Features list at its per-name defaults (AI_ANALYST DISABLED + ENABLED rest)', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Features');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Features');
  });

  it('#1092: folds Features even after AWS adds a brand-new (ENABLED) feature name', () => {
    const withNewFeature = {
      ...cleanLive,
      Features: [...defaultFeatures, { Status: 'ENABLED', Name: 'BRAND_NEW_FEATURE_2027' }],
    };
    const f = classifyResource(res, withNewFeature, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Features');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Features');
  });

  it('surfaces an out-of-band FindingPublishingFrequency lower than the default', () => {
    const changed = { ...cleanLive, FindingPublishingFrequency: 'FIFTEEN_MINUTES' };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('FindingPublishingFrequency');
    expect(pathsByTier(f, 'atDefault')).not.toContain('FindingPublishingFrequency');
  });

  it('surfaces an out-of-band disabled DataSources leaf (S3Logs.Enable=false)', () => {
    const changed = {
      ...cleanLive,
      DataSources: { ...defaultDataSources, S3Logs: { Enable: false } },
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('DataSources');
    expect(pathsByTier(f, 'atDefault')).not.toContain('DataSources');
  });

  // #1092: the security FNs the old value-independent Features fold + the trivial-empty drop hid.
  it('#1092: surfaces an out-of-band disable of a Features-only protection (RUNTIME_MONITORING)', () => {
    const changed = {
      ...cleanLive,
      Features: [
        ...defaultFeatures,
        { Status: 'ENABLED', Name: 'RDS_LOGIN_EVENTS' },
        { Status: 'DISABLED', Name: 'RUNTIME_MONITORING' }, // ENABLED-by-default -> disable surfaces
      ],
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Features');
    expect(pathsByTier(f, 'atDefault')).not.toContain('Features');
  });

  it('#1092: surfaces a disable nested in a feature AdditionalConfiguration', () => {
    const changed = {
      ...cleanLive,
      Features: [
        ...defaultFeatures,
        {
          Status: 'ENABLED',
          Name: 'RUNTIME_MONITORING',
          AdditionalConfiguration: [{ Status: 'DISABLED', Name: 'EKS_ADDON_MANAGEMENT' }],
        },
      ],
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Features');
  });

  it('#1092: surfaces a WHOLESALE all-false DataSources (was trivial-empty-dropped, invisible)', () => {
    const changed = {
      ...cleanLive,
      DataSources: {
        MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: false } },
        S3Logs: { Enable: false },
        Kubernetes: { AuditLogs: { Enable: false } },
      },
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('DataSources');
    expect(pathsByTier(f, 'atDefault')).not.toContain('DataSources');
  });
});

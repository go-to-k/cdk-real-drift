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
  // #1485: RUNTIME_MONITORING's creation default moved ENABLED->DISABLED across eras, so it is now
  // ONE_OF (a DISABLED runtime monitor is a valid clean-deploy default and no longer surfaces).
  // The #1092 FN-protection intent — an out-of-band disable of a still-default-ENABLED protection
  // surfaces — is re-expressed on RDS_LOGIN_EVENTS (unchanged ENABLED default).
  it('#1092/#1485: surfaces an out-of-band disable of a default-ENABLED protection (RDS_LOGIN_EVENTS)', () => {
    const changed = {
      ...cleanLive,
      Features: [
        ...defaultFeatures,
        { Status: 'DISABLED', Name: 'RDS_LOGIN_EVENTS' }, // ENABLED-by-default -> disable surfaces
      ],
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Features');
    expect(pathsByTier(f, 'atDefault')).not.toContain('Features');
  });

  // #1485: the granular AdditionalConfiguration agent-management members are DISABLED at creation,
  // so an out-of-band ENABLE (a billable protection turned on later) is the meaningful drift that
  // must surface — the nested-detection intent of the original #1092 test, updated for the moved
  // default.
  it('#1092/#1485: surfaces an out-of-band enable nested in a feature AdditionalConfiguration', () => {
    const changed = {
      ...cleanLive,
      Features: [
        ...defaultFeatures,
        {
          Status: 'DISABLED',
          Name: 'RUNTIME_MONITORING',
          AdditionalConfiguration: [{ Status: 'ENABLED', Name: 'EKS_ADDON_MANAGEMENT' }],
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

// #1485: a fresh `Enable: true`-only detector now (2026-07, us-east-1) materializes THREE features
// DISABLED at creation (AI_ANALYST / RUNTIME_MONITORING / EKS_RUNTIME_MONITORING, plus the latter
// two's AdditionalConfiguration agent-management members), breaking #1092's all-ENABLED gate and
// re-surfacing the whole Features array as first-run [Potential Drift]. The per-name creation-Status
// map must fold the clean model to atDefault while still surfacing an out-of-band ENABLE of an
// OFF-by-default protection.
describe('#1485 GuardDuty::Detector Features — new-era OFF-by-default protections', () => {
  const res: DesiredResource = {
    logicalId: 'HuntDetector',
    resourceType: 'AWS::GuardDuty::Detector',
    physicalId: '2fbe7ac257dc491d9992398365731fc9',
    declared: { Enable: true },
  };
  // The full live Features list of a fresh detector, harvested 2026-07-12 (issue #1485).
  const cleanFeatures = [
    { Status: 'DISABLED', Name: 'AI_ANALYST' },
    { Status: 'ENABLED', Name: 'CLOUD_TRAIL' },
    { Status: 'ENABLED', Name: 'DNS_LOGS' },
    { Status: 'ENABLED', Name: 'FLOW_LOGS' },
    { Status: 'ENABLED', Name: 'S3_DATA_EVENTS' },
    { Status: 'ENABLED', Name: 'EKS_AUDIT_LOGS' },
    { Status: 'ENABLED', Name: 'EBS_MALWARE_PROTECTION' },
    { Status: 'ENABLED', Name: 'RDS_LOGIN_EVENTS' },
    { Status: 'ENABLED', Name: 'LAMBDA_NETWORK_LOGS' },
    {
      Status: 'DISABLED',
      Name: 'EKS_RUNTIME_MONITORING',
      AdditionalConfiguration: [{ Status: 'DISABLED', Name: 'EKS_ADDON_MANAGEMENT' }],
    },
    {
      Status: 'DISABLED',
      Name: 'RUNTIME_MONITORING',
      AdditionalConfiguration: [
        { Status: 'DISABLED', Name: 'EKS_ADDON_MANAGEMENT' },
        { Status: 'DISABLED', Name: 'ECS_FARGATE_AGENT_MANAGEMENT' },
        { Status: 'DISABLED', Name: 'EC2_AGENT_MANAGEMENT' },
      ],
    },
  ];
  const cleanLive = {
    Enable: true,
    FindingPublishingFrequency: 'SIX_HOURS',
    Features: cleanFeatures,
  };

  it('folds the fresh-detector Features (three OFF-by-default protections) to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Features');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Features');
  });

  it('produces ZERO potential drift on the clean 2026 detector', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band ENABLE of AI_ANALYST (default DISABLED, billable enable)', () => {
    const changed = {
      ...cleanLive,
      Features: cleanFeatures.map((x) =>
        x.Name === 'AI_ANALYST' ? { ...x, Status: 'ENABLED' } : x
      ),
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Features');
    expect(pathsByTier(f, 'atDefault')).not.toContain('Features');
  });

  it('surfaces an out-of-band ENABLE of a nested agent-management member (EC2_AGENT_MANAGEMENT)', () => {
    const changed = {
      ...cleanLive,
      Features: cleanFeatures.map((x) =>
        x.Name === 'RUNTIME_MONITORING'
          ? {
              ...x,
              AdditionalConfiguration: (x.AdditionalConfiguration ?? []).map((m) =>
                m.Name === 'EC2_AGENT_MANAGEMENT' ? { ...m, Status: 'ENABLED' } : m
              ),
            }
          : x
      ),
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Features');
  });

  it('folds RUNTIME_MONITORING=ENABLED too (era ONE_OF — a detector created when it was ON-by-default)', () => {
    const olderEra = {
      ...cleanLive,
      Features: cleanFeatures.map((x) =>
        x.Name === 'RUNTIME_MONITORING' || x.Name === 'EKS_RUNTIME_MONITORING'
          ? { Status: 'ENABLED', Name: x.Name }
          : x
      ),
    };
    const f = classifyResource(res, olderEra, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Features');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Features');
  });
});

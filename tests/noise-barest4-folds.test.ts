// barest4 hunt (2026-07-14): first-run FP folds mined from clean, un-mutated LIVE deploys
// of the BAREST form of four rich-only-covered types (stacks CdkrdHunt0714Barest4A/B +
// CdkrdHunt0714CcPi, us-east-1). Every existing fixture/corpus case for these types
// DECLARED the suspect properties, so their undeclared-default path never ran:
//   EC2::FlowLog DestinationOptions        -> tier-1 KNOWN_DEFAULTS object constant
//   Synthetics::Canary Schedule.DurationInSeconds -> tier-1 KNOWN_DEFAULT_PATHS string "0"
//   RUM::AppMonitor CustomEvents + AppMonitorConfiguration -> tier-1 KNOWN_DEFAULTS
//   ServiceCatalog::TagOption Active       -> tier-1 KNOWN_DEFAULTS truthy-bool constant,
//     paired with a MEANINGFUL_WHEN_OFF gate (the #1503 TLSEnabled lesson) so an
//     out-of-band deactivate (undeclared false) still surfaces.
// Live models are copied verbatim from the harvested corpus of those deploys.
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

describe('EC2::FlowLog undeclared DestinationOptions (barest S3-destination flow log)', () => {
  const res: DesiredResource = {
    logicalId: 'FlowLog',
    resourceType: 'AWS::EC2::FlowLog',
    physicalId: 'fl-02e2f9eb4ca0c4938',
    declared: {
      LogDestination: 'arn:aws:s3:::cdkrd-hunt-bucket',
      LogDestinationType: 's3',
      ResourceId: 'vpc-00346b7ce53be4f32',
      ResourceType: 'VPC',
      TrafficType: 'ALL',
    },
  };
  const cleanLive = {
    ResourceId: 'vpc-00346b7ce53be4f32',
    ResourceType: 'VPC',
    TrafficType: 'ALL',
    LogDestination: 'arn:aws:s3:::cdkrd-hunt-bucket',
    LogDestinationType: 's3',
    LogFormat:
      '${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}',
    MaxAggregationInterval: 600,
    DestinationOptions: {
      PerHourPartition: false,
      HiveCompatiblePartitions: false,
      FileFormat: 'plain-text',
    },
  };

  it('produces ZERO potential drift on a clean, un-mutated flow log', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds the default DestinationOptions trio to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('DestinationOptions');
  });

  it('surfaces a non-default file format (Parquet) — the equality gate holds', () => {
    const changed = {
      ...cleanLive,
      DestinationOptions: {
        PerHourPartition: false,
        HiveCompatiblePartitions: false,
        FileFormat: 'parquet',
      },
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('DestinationOptions');
    expect(pathsByTier(f, 'atDefault')).not.toContain('DestinationOptions');
  });
});

describe('Synthetics::Canary undeclared Schedule.DurationInSeconds (barest canary)', () => {
  const res: DesiredResource = {
    logicalId: 'Canary',
    resourceType: 'AWS::Synthetics::Canary',
    physicalId: 'cdkrd-hunt-brst4',
    declared: {
      ArtifactS3Location: 's3://cdkrd-hunt-bucket/canary',
      Code: { Handler: 'index.handler', Script: 'exports.handler = async () => "ok";' },
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/canary-role',
      Name: 'cdkrd-hunt-brst4',
      RuntimeVersion: 'syn-nodejs-puppeteer-16.1',
      Schedule: { Expression: 'rate(0 hour)' },
    },
  };
  const cleanLive = {
    Name: 'cdkrd-hunt-brst4',
    ArtifactS3Location: 's3://cdkrd-hunt-bucket/canary',
    Code: { Handler: 'index.handler' },
    ExecutionRoleArn: 'arn:aws:iam::123456789012:role/canary-role',
    RuntimeVersion: 'syn-nodejs-puppeteer-16.1',
    // AWS materializes DurationInSeconds as the STRING "0" (run forever) on a schedule
    // that declares only Expression.
    Schedule: {
      DurationInSeconds: '0',
      RetryConfig: { MaxRetries: 0 },
      Expression: 'rate(0 hour)',
    },
    SuccessRetentionPeriod: 31,
    FailureRetentionPeriod: 31,
    ProvisionedResourceCleanup: 'AUTOMATIC',
    RunConfig: {
      TimeoutInSeconds: 840,
      MemoryInMB: 1500,
      EphemeralStorage: 1024,
      ActiveTracing: false,
    },
  };

  it('produces ZERO potential drift on a clean, un-mutated canary', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band duration limit — the equality gate holds', () => {
    const changed = {
      ...cleanLive,
      Schedule: { ...cleanLive.Schedule, DurationInSeconds: '600' },
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Schedule.DurationInSeconds');
  });
});

describe('RUM::AppMonitor undeclared defaults (barest monitor: Name + Domain only)', () => {
  const res: DesiredResource = {
    logicalId: 'Rum',
    resourceType: 'AWS::RUM::AppMonitor',
    physicalId: 'cdkrd-hunt-brst4',
    declared: { Domain: 'example.com', Name: 'cdkrd-hunt-brst4' },
  };
  const cleanLive = {
    Name: 'cdkrd-hunt-brst4',
    Domain: 'example.com',
    Platform: 'Web',
    CwLogEnabled: false,
    CustomEvents: { Status: 'DISABLED' },
    AppMonitorConfiguration: {
      IncludedPages: [],
      ExcludedPages: [],
      FavoritePages: [],
      SessionSampleRate: 0.1,
      Telemetries: [],
    },
    DeobfuscationConfiguration: { JavaScriptSourceMaps: { Status: 'DISABLED' } },
  };

  it('produces ZERO potential drift on a clean, un-mutated monitor', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds CustomEvents and AppMonitorConfiguration to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    expect(atDefault).toContain('CustomEvents');
    expect(atDefault).toContain('AppMonitorConfiguration');
  });

  it('surfaces an out-of-band custom-events ENABLE (the live-proven mutation)', () => {
    const changed = { ...cleanLive, CustomEvents: { Status: 'ENABLED' } };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('CustomEvents');
  });

  it('surfaces an out-of-band sampling-rate change', () => {
    const changed = {
      ...cleanLive,
      AppMonitorConfiguration: { ...cleanLive.AppMonitorConfiguration, SessionSampleRate: 1 },
    };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('AppMonitorConfiguration');
  });
});

describe('ServiceCatalog::TagOption undeclared Active (ccpi hunt)', () => {
  const res: DesiredResource = {
    logicalId: 'TagOption',
    resourceType: 'AWS::ServiceCatalog::TagOption',
    physicalId: 'tag-ijpe32hv55kou',
    declared: { Key: 'cdkrd-hunt', Value: 'ccpi' },
  };
  const cleanLive = {
    Key: 'cdkrd-hunt',
    Value: 'ccpi',
    Active: true,
  };

  it('produces ZERO potential drift on a clean, un-mutated tag option', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds the created-active default to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Active');
  });

  it('surfaces an out-of-band deactivate (undeclared false, via MEANINGFUL_WHEN_OFF)', () => {
    // Without the MEANINGFUL_WHEN_OFF gate the live `false` is dropped by isTrivialEmpty
    // before the pin gate, hiding the deactivation (live-proven detect on ccpi-hunt).
    const changed = { ...cleanLive, Active: false };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Active');
    expect(pathsByTier(f, 'atDefault')).not.toContain('Active');
  });
});

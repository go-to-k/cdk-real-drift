// #1702 — the remaining truthy-pin off-flip FN candidates, live-probed 2026-08-02:
// - Route53 HealthCheck HealthCheckConfig.EnableSNI: an HTTPS check fills `true` at
//   creation and an out-of-band `--no-enable-sni` reads back a PRESENT `false`
//   (previously swallowed by isTrivialEmpty); a non-HTTPS check reads `false` at
//   CREATION, so the MEANINGFUL_WHEN_OFF_NESTED gate is CONDITIONAL on the type.
// - ImageBuilder ImagePipeline ImageTestsConfiguration.ImageTestsEnabled: the partial
//   shape (only TimeoutMinutes declared) fills `true`, and an out-of-band disable reads
//   back a PRESENT `false` emitted as a lone leaf — per-leaf pins + an unconditional gate.
// - AppRunner Service NetworkConfiguration.IngressConfiguration: the partial shape
//   (only EgressConfiguration declared) fills {IsPubliclyAccessible: true} + IpAddressType
//   IPV4, and an out-of-band flip to private reads back a PRESENT all-false object —
//   whole-sub-object pin + unconditional gate, plus the IpAddressType per-leaf constant.
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

describe('#1702 Route53 HealthCheck EnableSNI conditional off-flip gate', () => {
  const mkHc = (config: Record<string, unknown>): DesiredResource => ({
    logicalId: 'Hc',
    resourceType: 'AWS::Route53::HealthCheck',
    physicalId: 'f2fee341-5bc6-4b4b-90ca-fa1235240a93',
    declared: { HealthCheckConfig: config },
  });
  // The exact live fill from the 2026-08-02 probe (an HTTPS check declaring only
  // Type + FQDN).
  const httpsDeclared = { Type: 'HTTPS', FullyQualifiedDomainName: 'example.com' };
  const httpsLiveClean = {
    HealthCheckConfig: {
      ...httpsDeclared,
      EnableSNI: true,
      MeasureLatency: false,
      Inverted: false,
      Port: 443,
      RequestInterval: 30,
      FailureThreshold: 3,
    },
  };

  it('a clean HTTPS check folds the EnableSNI true fill (zero undeclared)', () => {
    const f = classifyResource(mkHc(httpsDeclared), httpsLiveClean, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band --no-enable-sni on an HTTPS check surfaces (off-state gate)', () => {
    const f = classifyResource(
      mkHc(httpsDeclared),
      {
        HealthCheckConfig: {
          ...httpsLiveClean['HealthCheckConfig'],
          EnableSNI: false,
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['HealthCheckConfig.EnableSNI']);
  });

  it('a non-HTTPS check reading its creation-state EnableSNI false stays clean (conditional gate)', () => {
    const httpDeclared = { Type: 'HTTP', FullyQualifiedDomainName: 'example.com' };
    const f = classifyResource(
      mkHc(httpDeclared),
      {
        HealthCheckConfig: {
          ...httpDeclared,
          EnableSNI: false,
          MeasureLatency: false,
          Inverted: false,
          Port: 80,
          RequestInterval: 30,
          FailureThreshold: 3,
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

describe('#1702 AppRunner Service partial-declared NetworkConfiguration', () => {
  // The exact live fill from the 2026-08-02 probe (a service declaring only
  // EgressConfiguration).
  const declared = {
    ServiceName: 'cdkrd-1702-ar',
    SourceConfiguration: {
      ImageRepository: {
        ImageIdentifier: 'public.ecr.aws/aws-containers/hello-app-runner:latest',
        ImageRepositoryType: 'ECR_PUBLIC',
      },
      AutoDeploymentsEnabled: false,
    },
    NetworkConfiguration: { EgressConfiguration: { EgressType: 'DEFAULT' } },
  };
  const mk = (): DesiredResource => ({
    logicalId: 'Svc',
    resourceType: 'AWS::AppRunner::Service',
    physicalId: 'arn:aws:apprunner:us-east-1:111111111111:service/cdkrd-1702-ar/abc123',
    declared,
  });
  const liveNetClean = {
    IpAddressType: 'IPV4',
    EgressConfiguration: { EgressType: 'DEFAULT' },
    IngressConfiguration: { IsPubliclyAccessible: true },
  };

  it('the partial shape folds the IngressConfiguration + IpAddressType fills (zero undeclared)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, NetworkConfiguration: liveNetClean },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band flip to private surfaces the all-false object (off-state gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        NetworkConfiguration: {
          ...liveNetClean,
          IngressConfiguration: { IsPubliclyAccessible: false },
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['NetworkConfiguration.IngressConfiguration']);
  });

  it('an out-of-band dualstack migration surfaces (IpAddressType equality gate)', () => {
    const f = classifyResource(
      mk(),
      { ...declared, NetworkConfiguration: { ...liveNetClean, IpAddressType: 'DUAL_STACK' } },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['NetworkConfiguration.IpAddressType']);
  });
});

describe('#1702 ImageBuilder ImagePipeline partial-declared ImageTestsConfiguration', () => {
  const declared = {
    Name: 'cdkrd-1702-pipe',
    ImageRecipeArn: 'arn:aws:imagebuilder:us-east-1:111111111111:image-recipe/r/1.0.0',
    InfrastructureConfigurationArn:
      'arn:aws:imagebuilder:us-east-1:111111111111:infrastructure-configuration/i',
    ImageTestsConfiguration: { TimeoutMinutes: 90 },
  };
  const mk = (): DesiredResource => ({
    logicalId: 'Pipe',
    resourceType: 'AWS::ImageBuilder::ImagePipeline',
    physicalId: 'arn:aws:imagebuilder:us-east-1:111111111111:image-pipeline/cdkrd-1702-pipe',
    declared,
  });

  it('the partial shape folds the ImageTestsEnabled true fill (zero undeclared)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        ImageTestsConfiguration: { TimeoutMinutes: 90, ImageTestsEnabled: true },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('an out-of-band test disable surfaces as the lone false leaf (off-state gate)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        ImageTestsConfiguration: { TimeoutMinutes: 90, ImageTestsEnabled: false },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['ImageTestsConfiguration.ImageTestsEnabled']);
  });

  it('the inverse partial shape folds the TimeoutMinutes 720 fill and surfaces a change', () => {
    const invDeclared = {
      ...declared,
      ImageTestsConfiguration: { ImageTestsEnabled: true },
    };
    const mkInv = (): DesiredResource => ({ ...mk(), declared: invDeclared });
    const clean = classifyResource(
      mkInv(),
      { ...invDeclared, ImageTestsConfiguration: { ImageTestsEnabled: true, TimeoutMinutes: 720 } },
      emptySchema
    );
    expect(pathsByTier(clean, 'undeclared')).toEqual([]);
    const drifted = classifyResource(
      mkInv(),
      { ...invDeclared, ImageTestsConfiguration: { ImageTestsEnabled: true, TimeoutMinutes: 60 } },
      emptySchema
    );
    expect(pathsByTier(drifted, 'undeclared')).toEqual(['ImageTestsConfiguration.TimeoutMinutes']);
  });
});

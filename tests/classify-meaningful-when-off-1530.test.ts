// #1530: an out-of-band DISABLE of a boolean that KNOWN_DEFAULTS / KNOWN_DEFAULT_PATHS pins
// `true` is swallowed by isTrivialEmpty BEFORE the pin gate unless the property has a paired
// MEANINGFUL_WHEN_OFF / MEANINGFUL_WHEN_OFF_NESTED entry. These tests pin the four pairings
// added by #1530: the clean-deploy `true` still folds atDefault, and the off-flip now
// surfaces as undeclared drift. Live-proven on a fresh barest ClientVPN endpoint
// (2026-07-12: `modify-client-vpn-endpoint --no-disconnect-on-session-timeout` was
// invisible on the base binary — check stayed CLEAN, exit 0).
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

describe('#1530 ClientVpnEndpoint.DisconnectOnSessionTimeout off-flip', () => {
  const res: DesiredResource = {
    logicalId: 'Endpoint',
    resourceType: 'AWS::EC2::ClientVpnEndpoint',
    physicalId: 'cvpn-endpoint-0dd25d1211ee9cf11',
    declared: {
      ClientCidrBlock: '10.100.0.0/22',
      ServerCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x',
      ConnectionLogOptions: { Enabled: false },
    },
  };
  const live = (disconnect: boolean) => ({
    ClientCidrBlock: '10.100.0.0/22',
    ServerCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x',
    ConnectionLogOptions: { Enabled: false },
    DisconnectOnSessionTimeout: disconnect,
    SessionTimeoutHours: 24,
    TransportProtocol: 'udp',
    VpnPort: 443,
  });

  it('folds the clean-deploy true to atDefault (first-run stays CLEAN)', () => {
    const f = classifyResource(res, live(true), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('DisconnectOnSessionTimeout');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band --no-disconnect-on-session-timeout (the live-proven FN)', () => {
    const f = classifyResource(res, live(false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['DisconnectOnSessionTimeout']);
    // The untouched sibling defaults still fold.
    expect(pathsByTier(f, 'atDefault')).toContain('SessionTimeoutHours');
  });
});

describe('#1530 ImageBuilder off-flips (EnhancedImageMetadataEnabled / TerminateInstanceOnFailure)', () => {
  const pipeline: DesiredResource = {
    logicalId: 'Pipeline',
    resourceType: 'AWS::ImageBuilder::ImagePipeline',
    physicalId: 'arn:aws:imagebuilder:us-east-1:111111111111:image-pipeline/p',
    declared: { Name: 'p' },
  };
  const infra: DesiredResource = {
    logicalId: 'Infra',
    resourceType: 'AWS::ImageBuilder::InfrastructureConfiguration',
    physicalId: 'arn:aws:imagebuilder:us-east-1:111111111111:infrastructure-configuration/i',
    declared: { Name: 'i' },
  };

  it('pipeline: clean-deploy true folds, out-of-band false surfaces', () => {
    const clean = classifyResource(
      pipeline,
      { Name: 'p', EnhancedImageMetadataEnabled: true },
      emptySchema
    );
    expect(pathsByTier(clean, 'atDefault')).toContain('EnhancedImageMetadataEnabled');
    expect(pathsByTier(clean, 'undeclared')).toEqual([]);
    const flipped = classifyResource(
      pipeline,
      { Name: 'p', EnhancedImageMetadataEnabled: false },
      emptySchema
    );
    expect(pathsByTier(flipped, 'undeclared')).toEqual(['EnhancedImageMetadataEnabled']);
  });

  it('infrastructure configuration: clean-deploy true folds, out-of-band false surfaces', () => {
    const clean = classifyResource(
      infra,
      { Name: 'i', TerminateInstanceOnFailure: true },
      emptySchema
    );
    expect(pathsByTier(clean, 'atDefault')).toContain('TerminateInstanceOnFailure');
    expect(pathsByTier(clean, 'undeclared')).toEqual([]);
    const flipped = classifyResource(
      infra,
      { Name: 'i', TerminateInstanceOnFailure: false },
      emptySchema
    );
    expect(pathsByTier(flipped, 'undeclared')).toEqual(['TerminateInstanceOnFailure']);
  });
});

describe('#1530 ECS Service nested DeploymentCircuitBreaker.ResetOnHealthyTask off-flip', () => {
  const RESET = 'DeploymentConfiguration.DeploymentCircuitBreaker.ResetOnHealthyTask';
  const res = (enable: boolean): DesiredResource => ({
    logicalId: 'Svc',
    resourceType: 'AWS::ECS::Service',
    physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/c/s',
    declared: {
      ServiceName: 's',
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: enable, Rollback: false },
      },
    },
  });
  const live = (enable: boolean, reset: boolean) => ({
    ServiceName: 's',
    DeploymentConfiguration: {
      DeploymentCircuitBreaker: { Enable: enable, Rollback: false, ResetOnHealthyTask: reset },
    },
  });

  it('folds the AWS-filled true sub-default on a breaker-enabled service', () => {
    const f = classifyResource(res(true), live(true, true), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain(RESET);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band ResetOnHealthyTask=false on a breaker-enabled service', () => {
    const f = classifyResource(res(true), live(true, false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([RESET]);
  });

  it('keeps an untouched false hidden when the breaker is NOT enabled (predicate gate)', () => {
    // A disabled circuit breaker's ResetOnHealthyTask=false is a legitimate creation-time
    // shape (AWS never filled the sub-default), not an out-of-band disable — stay folded.
    const f = classifyResource(res(false), live(false, false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

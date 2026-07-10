// #1286 — the #1236 crossRegionReferences (`/cdk/exports/*`) prefetch built its SSMClient
// BARE: `new SSMClient(credentials ? { region, credentials } : { region })`. Every other AWS
// client in cdkrd (including the OTHER SSMClient in read/overrides.ts) spreads READ_RETRY, so
// the bare construction alone got SDK DEFAULTS — no request/connection timeout (#1066: a
// stalled/silent SSM endpoint hangs check/record FOREVER right here) and maxAttempts 3 with
// standard retry (vs the fleet's adaptive maxAttempts 10 — a transient ThrottlingException
// aborts the prefetch and downgrades EVERY reader GetAtt in the stack to UNRESOLVED for the
// run). The fix spreads READ_RETRY into the client, keeping the CFn-inherited `credentials`
// LAST so an explicit `--profile` identity still wins over READ_RETRY's default chain.
//
// We intercept the SSMClient construction (module-mock, preserving the real
// GetParametersCommand) to capture the exact config `loadDesired` passes, then drive the same
// crossRegionReferences prefetch loadDesired uses and assert that config carries READ_RETRY
// AND preserves the explicit credentials. This test FAILS against the bare client (no
// maxAttempts / retryMode / requestHandler) and PASSES with the fix.
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CLIENT_TIMEOUTS, READ_RETRY } from '../src/read/client-config.js';

// Capture every SSMClient config the code under test constructs. `vi.hoisted` so the array is
// live when the mock factory (hoisted above the imports) runs.
const captured = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

// Mock only the SSMClient constructor; keep the real GetParametersCommand + types so the
// prefetch's `.send(new GetParametersCommand(...))` path is otherwise unchanged. The stub
// records its config and returns the value the prefetch expects.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ssm')>();
  return {
    ...actual,
    SSMClient: class {
      config: Record<string, unknown>;
      constructor(cfg: Record<string, unknown>) {
        captured.configs.push(cfg);
        this.config = cfg;
      }
      // getCrossRegionExports calls client.send(new GetParametersCommand(...)).
      send() {
        return Promise.resolve({
          Parameters: [{ Name: '/cdk/exports/MyCertArn', Value: CERT_ARN }],
        });
      }
      destroy() {}
    },
  };
});

const { loadDesired } = await import('../src/desired/template-adapter.js');

const CERT_ARN = 'arn:aws:acm:us-east-1:111122223333:certificate/live-cert';

// A minimal crossRegionReferences template: a reader + a consumer GetAtt to /cdk/exports/*,
// which is exactly what triggers the prefetch (collectCrossRegionExportNames non-empty).
const template = {
  Resources: {
    Reader: { Type: 'Custom::CrossRegionExportReader' },
    Dist: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        ViewerCertificate: {
          AcmCertificateArn: { 'Fn::GetAtt': ['Reader', '/cdk/exports/MyCertArn'] },
        },
      },
    },
  },
};

// Build a CFn client mock whose account is unique per test (the module-level prefetch cache is
// keyed by account+region — a shared account would let one test's captured config satisfy the
// next without a fresh construction).
function mockCfn(account: string): CloudFormationClient {
  const cfn = mockClient(CloudFormationClient);
  cfn.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(template) });
  cfn.on(ListStackResourcesCommand).resolves({
    StackResourceSummaries: [
      {
        LogicalResourceId: 'Dist',
        PhysicalResourceId: 'dist-phys',
        ResourceType: 'AWS::CloudFront::Distribution',
        LastUpdatedTimestamp: new Date(0),
        ResourceStatus: 'CREATE_COMPLETE',
      },
      {
        LogicalResourceId: 'Reader',
        PhysicalResourceId: 'reader-phys',
        ResourceType: 'Custom::CrossRegionExportReader',
        LastUpdatedTimestamp: new Date(0),
        ResourceStatus: 'CREATE_COMPLETE',
      },
    ],
  });
  cfn.on(DescribeStacksCommand).resolves({
    Stacks: [
      {
        StackId: `arn:aws:cloudformation:eu-west-1:${account}:stack/S/x`,
        StackName: 'S',
        CreationTime: new Date(0),
        StackStatus: 'CREATE_COMPLETE',
        Parameters: [],
      },
    ],
  });
  return cfn as unknown as CloudFormationClient;
}

describe('#1286 crossRegion SSM prefetch client gets READ_RETRY (timeouts + adaptive retry)', () => {
  beforeEach(() => {
    captured.configs.length = 0;
  });

  it('constructs the prefetch SSMClient WITH the READ_RETRY timeouts + retry budget', async () => {
    const cfn = mockCfn('100000000001');
    await loadDesired(cfn, 'S', 'eu-west-1');

    // exactly the crossRegion prefetch client was constructed
    expect(captured.configs.length).toBeGreaterThanOrEqual(1);
    const cfg = captured.configs[captured.configs.length - 1];

    // #1066 timeouts + adaptive retry — the exact READ_RETRY contract every other client gets.
    // Against the pre-fix bare `{ region }` these are all undefined and the test fails.
    expect(cfg.maxAttempts).toBe(READ_RETRY.maxAttempts); // 10, vs the SDK default 3
    expect(cfg.retryMode).toBe(READ_RETRY.retryMode); // 'adaptive', vs 'standard'
    // same shared requestHandler reference (the #1066 connection/request timeouts)
    expect(cfg.requestHandler).toBe(CLIENT_TIMEOUTS.requestHandler);
    expect(cfg.region).toBe('eu-west-1');
  });

  it('preserves the explicit CFn credentials — they win over READ_RETRY.credentials (--profile precedence)', async () => {
    // A `--profile` run resolves credentials on the CFn client; the prefetch inherits them.
    // The spread order (`{ region, ...READ_RETRY, credentials }`) must keep THESE last so they
    // are not overwritten by READ_RETRY's default CLIENT_CREDENTIALS chain.
    const explicitCreds = async () => ({
      accessKeyId: 'AKIAEXPLICIT',
      secretAccessKey: 'explicit-secret',
    });
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(template) });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Dist',
          PhysicalResourceId: 'dist-phys',
          ResourceType: 'AWS::CloudFront::Distribution',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
        {
          LogicalResourceId: 'Reader',
          PhysicalResourceId: 'reader-phys',
          ResourceType: 'Custom::CrossRegionExportReader',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:eu-west-1:100000000002:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
    // The prefetch reads client.config?.credentials off the CFn client — plant the explicit creds.
    (cfn as unknown as { config: { credentials: unknown } }).config = {
      credentials: explicitCreds,
    };

    await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'eu-west-1');

    expect(captured.configs.length).toBeGreaterThanOrEqual(1);
    const cfg = captured.configs[captured.configs.length - 1];
    // Explicit credentials survived the READ_RETRY spread (came LAST), and READ_RETRY's own
    // timeouts/retry are still present alongside them.
    expect(cfg.credentials).toBe(explicitCreds);
    expect(cfg.credentials).not.toBe(READ_RETRY.credentials);
    expect(cfg.maxAttempts).toBe(READ_RETRY.maxAttempts);
    expect(cfg.retryMode).toBe(READ_RETRY.retryMode);
    expect(cfg.requestHandler).toBe(CLIENT_TIMEOUTS.requestHandler);
  });
});

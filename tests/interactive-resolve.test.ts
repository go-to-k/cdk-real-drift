import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock the prompt: the top menu `select` returns 'revert-all' once, isCancel is false.
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, select: vi.fn(), isCancel: () => false };
});

// Mock stack-actions: keep the real availableActions / buildRevertPlan etc., but replace
// the AWS-mutating revertStack with a spy so we can assert HOW the interactive menu calls
// it (specifically: yes must be false so the AWS-write confirm fires under read-only check).
vi.mock('../src/commands/stack-actions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    revertStack: vi.fn().mockResolvedValue({ exit: 0, aborted: false }),
  };
});

import { select } from '@clack/prompts';
import { resolveInteractively } from '../src/commands/interactive-resolve.js';
import { revertStack } from '../src/commands/stack-actions.js';
import type { Finding } from '../src/types.js';

const declaredDrift: Finding = {
  tier: 'declared',
  logicalId: 'B',
  physicalId: 'b-phys',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration.Status',
  desired: 'Enabled',
  actual: 'Suspended',
};

const params = (yes: boolean) =>
  ({
    stackName: 'S',
    region: 'us-east-1',
    // only `.resources` is read on the revert path (declaredKeysByLogical + gathered.desired)
    desired: { resources: [{ logicalId: 'B', resourceType: 'AWS::S3::Bucket', declared: {} }] },
    findings: [declaredDrift],
    reconciled: [declaredDrift],
    baseline: undefined,
    schemas: new Map(),
    liveByLogical: new Map(),
    config: { version: 1, ignore: [] },
    code: 1,
    yes,
    removeUnrecorded: false,
    verbose: false,
  }) as unknown as Parameters<typeof resolveInteractively>[0];

describe('resolveInteractively — read-only check never auto-confirms an AWS write', () => {
  beforeEach(() => {
    vi.mocked(revertStack).mockClear();
    vi.mocked(select).mockReset();
  });

  it('"Revert all" forces yes:false to revertStack EVEN WHEN check was run with --yes', async () => {
    vi.mocked(select).mockResolvedValueOnce('revert-all');
    await resolveInteractively(params(true)); // check --yes
    expect(revertStack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(revertStack).mock.calls[0]![0]).toMatchObject({ yes: false });
  });

  it('"Revert all" also passes yes:false without --yes (unchanged behavior)', async () => {
    vi.mocked(select).mockResolvedValueOnce('revert-all');
    await resolveInteractively(params(false));
    expect(vi.mocked(revertStack).mock.calls[0]![0]).toMatchObject({ yes: false });
  });
});

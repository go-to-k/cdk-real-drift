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
    ignoreStack: vi.fn().mockResolvedValue({ wrote: false, refused: false, added: 0 }),
    recordStack: vi.fn().mockResolvedValue({ wrote: true, refused: false }),
  };
});

import { select } from '@clack/prompts';
import {
  buildScopeOptions,
  isFoldedFinding,
  pickerLabel,
  resolveInteractively,
} from '../src/commands/interactive-resolve.js';
import { ignoreStack, recordStack, revertStack } from '../src/commands/stack-actions.js';
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

// PR #452: a declared-only stack with NO baseline yet must still OFFER Record (establish the
// day-1 baseline + start undeclared watching), worded honestly that the declared drift stays
// reported. This drives the whole menu end-to-end: the option appears, and choosing it routes
// to recordStack (the establish write) rather than being silently absent.
describe('resolveInteractively — declared-only + no baseline still offers + routes Record (establish)', () => {
  beforeEach(() => {
    vi.mocked(recordStack).mockClear();
    vi.mocked(recordStack).mockResolvedValue({ wrote: true, refused: false });
    vi.mocked(select).mockReset();
  });

  it('offers record-all (establish-drift label) and routes the choice to recordStack', async () => {
    vi.mocked(select)
      .mockResolvedValueOnce('record-all') // top menu: choose Record (establish)
      .mockResolvedValueOnce('nothing'); // re-shown menu (declared drift remains) → exit
    await resolveInteractively(params(false));

    // the Record option WAS in the first menu, worded for the coexisting declared drift
    const firstMenu = vi.mocked(select).mock.calls[0]![0] as {
      options: { value: string; label: string }[];
    };
    const recordOpt = firstMenu.options.find((o) => o.value === 'record-all');
    expect(recordOpt).toBeDefined();
    expect(recordOpt!.label).toContain('Record current state as the .cdkrd baseline');
    expect(recordOpt!.label).toContain('the declared drift stays reported');

    // choosing it routed to the establish write (recordStack), not a no-op
    expect(recordStack).toHaveBeenCalledTimes(1);
  });
});

describe('isFoldedFinding — mirrors report.ts R96 fold (unrecorded + nested)', () => {
  const f = (extra: Partial<Finding>): Finding =>
    ({
      tier: 'undeclared',
      logicalId: 'L',
      resourceType: 'T',
      path: 'a.b',
      actual: 1,
      ...extra,
    }) as Finding;
  it('a nested unrecorded value is folded', () => {
    expect(isFoldedFinding(f({ unrecorded: true, nested: true }), false)).toBe(true);
  });
  it('a top-level unrecorded value (not nested) is NOT folded — it lists in the report', () => {
    expect(isFoldedFinding(f({ unrecorded: true }), false)).toBe(false);
  });
  it('a nested but RECORDED/drift value is NOT folded', () => {
    expect(isFoldedFinding(f({ nested: true }), false)).toBe(false);
  });
  it('--verbose expands everything, so nothing is folded', () => {
    expect(isFoldedFinding(f({ unrecorded: true, nested: true }), true)).toBe(false);
  });
});

describe('buildScopeOptions — the shown-vs-include-folded rows', () => {
  it('labels the two scopes with their counts and a running total', () => {
    const opts = buildScopeOptions(3, 23);
    expect(opts.map((o) => o.value)).toEqual(['shown', 'all']);
    expect(opts[0]!.label).toContain('3 shown');
    expect(opts[1]!.label).toContain('23 folded');
    expect(opts[1]!.label).toContain('26 total');
  });
});

describe('scope gate narrows the ignore picker to the report-shown findings (default)', () => {
  const undeclaredFolded = (path: string): Finding =>
    ({
      tier: 'undeclared',
      logicalId: 'B',
      resourceType: 'AWS::S3::Bucket',
      path,
      actual: 'x',
      unrecorded: true,
      nested: true,
    }) as Finding;
  const withFolded = (yes: boolean) => {
    const reconciled = [declaredDrift, undeclaredFolded('Conf.A'), undeclaredFolded('Conf.B')];
    return { ...params(yes), findings: reconciled, reconciled } as Parameters<
      typeof resolveInteractively
    >[0];
  };

  beforeEach(() => {
    vi.mocked(ignoreStack).mockClear();
    vi.mocked(ignoreStack).mockResolvedValue({ wrote: false, refused: false, added: 0 });
    vi.mocked(select).mockReset();
  });

  it('choosing "Ignore" then scope "shown" passes ONLY the 1 shown drift (not the 2 folded)', async () => {
    vi.mocked(select)
      .mockResolvedValueOnce('ignore-all') // top menu
      .mockResolvedValueOnce('shown') // scope gate
      .mockResolvedValueOnce('nothing'); // re-shown menu → exit (ignoreStack returned wrote:false)
    await resolveInteractively(withFolded(false));
    expect(ignoreStack).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(ignoreStack).mock.calls[0]![0].findings;
    expect(passed).toHaveLength(1);
    expect(passed[0]!.tier).toBe('declared');
  });

  it('choosing scope "all" passes the shown drift AND the 2 folded undeclared values', async () => {
    vi.mocked(select)
      .mockResolvedValueOnce('ignore-all')
      .mockResolvedValueOnce('all')
      .mockResolvedValueOnce('nothing');
    await resolveInteractively(withFolded(false));
    expect(vi.mocked(ignoreStack).mock.calls[0]![0].findings).toHaveLength(3);
  });

  it('--yes skips the scope prompt and passes the full set (1 top-menu select only)', async () => {
    vi.mocked(select).mockResolvedValueOnce('ignore-all').mockResolvedValueOnce('nothing');
    await resolveInteractively(withFolded(true));
    expect(vi.mocked(ignoreStack).mock.calls[0]![0].findings).toHaveLength(3);
    // exactly two select calls: top menu + the re-shown menu — no scope prompt in between
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
  });
});

describe('pickerLabel — the per-finding "decide per finding" row (mirrors the report)', () => {
  const uf = (over: Partial<Finding>): Finding => ({
    tier: 'undeclared',
    logicalId: 'R',
    resourceType: 'AWS::IAM::Role',
    path: 'Policies',
    ...over,
  });

  it('shows the construct path WITHIN the stack when given the stack name', () => {
    const f = uf({ constructPath: 'my-app/Api/ApiRole' });
    // a CDK Stage: aws:cdk:path is my-app/Api/..., the CFn name is my-app-Api
    expect(pickerLabel(f, 'my-app-Api')).toContain('ApiRole.Policies  (');
    expect(pickerLabel(f, 'my-app-Api')).not.toContain('my-app/Api/ApiRole');
    // no stackName -> full construct path (unit default)
    expect(pickerLabel(f)).toContain('my-app/Api/ApiRole.Policies  (');
  });

  it('keeps the attributeKey suffix after the stripped id', () => {
    const f = uf({
      constructPath: 'S/Edge',
      path: 'LoadBalancerAttributes',
      attributeKey: 'idle_timeout.timeout_seconds',
    });
    expect(pickerLabel(f, 'S')).toContain(
      'Edge.LoadBalancerAttributes[idle_timeout.timeout_seconds]'
    );
  });
});

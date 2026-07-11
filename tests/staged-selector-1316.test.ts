import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { assertNoStackErrors, positionalMatchesStack } from '../src/commands/resolve-stacks.js';
import { stackErrorMessages } from '../src/synth/synth.js';

// #1316: for a stack nested in a CDK `Stage`, cdkrd and toolkit-lib disagreed on the identifying
// name — resolveStacks matched a CLI positional against the deployed `stackName` (`Dev-Net`), while
// the #905 synth selector forwarded the SAME positional to `toolkit.synth`, which matches on the
// `hierarchicalId` (`Dev/Net`, picomatch — `*` does not cross `/`). Two bugs:
//   1. UX inversion — `cdk synth Dev/Net` works but cdkrd only accepted `Dev-Net`, and vice versa.
//   2. Validation silently disabled — `toolkit.synth` runs metadata validation only on the
//      selector-matched collection; a `Dev-Net` positional matches ZERO hierarchicalIds, so an
//      `Annotations.addError(...)` that would abort a no-args check is silently ignored.
// The fix threads `hierarchicalId` + the stack's error-level messages through discovery, matches a
// positional against BOTH identifiers, and re-checks the selected stacks' error annotations.

describe('stackErrorMessages (#1316) — extract a stack artifact ERROR-level annotations', () => {
  it('returns [] for no messages / undefined', () => {
    expect(stackErrorMessages(undefined)).toEqual([]);
    expect(stackErrorMessages([])).toEqual([]);
  });

  it('keeps only level "error" (an addError), dropping info/warning', () => {
    const msgs = [
      { level: 'info', entry: { data: 'just fyi' } },
      { level: 'warning', entry: { data: 'be careful' } },
      { level: 'error', entry: { data: 'THIS STACK IS BROKEN' } },
    ];
    expect(stackErrorMessages(msgs)).toEqual(['THIS STACK IS BROKEN']);
  });

  it('surfaces the human-readable entry.data, falling back to "error" when absent', () => {
    expect(
      stackErrorMessages([
        { level: 'error', entry: { data: 'cdk-nag AwsSolutions-IAM5' } },
        { level: 'error', entry: {} },
        { level: 'error' },
      ])
    ).toEqual(['cdk-nag AwsSolutions-IAM5', 'error', 'error']);
  });
});

describe('positionalMatchesStack (#1316) — a positional matches stackName OR hierarchicalId', () => {
  const staged = { stackName: 'Dev-Net', hierarchicalId: 'Dev/Net' };

  it('matches the cdk-native hierarchicalId form (Dev/Net)', () => {
    expect(positionalMatchesStack('Dev/Net', staged)).toBe(true);
  });

  it('matches the deployed stackName form (Dev-Net)', () => {
    expect(positionalMatchesStack('Dev-Net', staged)).toBe(true);
  });

  it('does NOT match an unrelated name', () => {
    expect(positionalMatchesStack('Prod/Net', staged)).toBe(false);
    expect(positionalMatchesStack('Dev-Web', staged)).toBe(false);
  });

  it('a glob matches the hierarchicalId (Dev/* → Dev/Net)', () => {
    expect(positionalMatchesStack('Dev/*', staged)).toBe(true);
  });

  it('a glob matches the stackName form too (Dev-* → Dev-Net)', () => {
    expect(positionalMatchesStack('Dev-*', staged)).toBe(true);
  });

  it('a top-level stack (identifiers identical) is unchanged', () => {
    const top = { stackName: 'Top', hierarchicalId: 'Top' };
    expect(positionalMatchesStack('Top', top)).toBe(true);
    expect(positionalMatchesStack('To*', top)).toBe(true);
    expect(positionalMatchesStack('Nope', top)).toBe(false);
  });

  it('an absent hierarchicalId degrades to a stackName-only match (no crash)', () => {
    expect(positionalMatchesStack('Solo', { stackName: 'Solo' })).toBe(true);
    expect(positionalMatchesStack('So*', { stackName: 'Solo' })).toBe(true);
  });
});

describe('assertNoStackErrors (#1316) — abort on a SELECTED stack error annotation', () => {
  it('is a no-op when no selected stack carries an error', () => {
    expect(() =>
      assertNoStackErrors([
        { stackName: 'A', errorMessages: [] },
        { stackName: 'B', errorMessages: [] },
      ])
    ).not.toThrow();
  });

  it('throws (naming the stack + message) when a selected stack has an addError', () => {
    expect(() =>
      assertNoStackErrors([{ stackName: 'Dev-Net', errorMessages: ['THIS STACK IS BROKEN'] }])
    ).toThrow(/Dev-Net: THIS STACK IS BROKEN/);
  });

  it('aggregates errors across multiple selected stacks', () => {
    let caught: Error | undefined;
    try {
      assertNoStackErrors([
        { stackName: 'Dev-Net', errorMessages: ['broken A'] },
        { stackName: 'Dev-Web', errorMessages: ['broken B1', 'broken B2'] },
      ]);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('3 error(s)');
    expect(caught?.message).toContain('Dev-Net: broken A');
    expect(caught?.message).toContain('Dev-Web: broken B1');
    expect(caught?.message).toContain('Dev-Web: broken B2');
  });

  it('degrades to no-op for a caller without errorMessages (no crash)', () => {
    expect(() => assertNoStackErrors([{ stackName: 'A' }])).not.toThrow();
  });
});

// End-to-end through resolveStacks with discoverStacks mocked: assert BOTH identifier forms
// resolve the staged stack, a Dev/* glob matches it, and a stackName-form positional aborts on the
// staged stack's error annotation (the validation the hierarchicalId selector would have skipped).
vi.mock('../src/synth/resolve-app.js', () => ({
  resolveApp: () => 'app',
}));

interface Disc {
  stackName: string;
  hierarchicalId: string;
  region: string | undefined;
  account: string | undefined;
  errorMessages: string[];
  template: Record<string, unknown>;
}

// A CDK app: a top-level `Top` stack + a `Net` stack nested in a `Dev` Stage (deployed stackName
// `Dev-Net`, hierarchicalId `Dev/Net`). `stagedErrors` is injected per-test to simulate an
// Annotations.addError on the staged stack.
let stagedErrors: string[] = [];
const discovered = (): Disc[] => [
  {
    stackName: 'Top',
    hierarchicalId: 'Top',
    region: 'us-east-1',
    account: undefined,
    errorMessages: [],
    template: { top: true },
  },
  {
    stackName: 'Dev-Net',
    hierarchicalId: 'Dev/Net',
    region: 'us-east-1',
    account: undefined,
    errorMessages: stagedErrors,
    template: { net: true },
  },
];
vi.mock('../src/synth/synth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/synth/synth.js')>();
  return { ...actual, discoverStacks: () => Promise.resolve(discovered()) };
});

import type { CommonArgs } from '../src/cli-args.js';
import { resolveStacks } from '../src/commands/resolve-stacks.js';

function args(overrides: Partial<CommonArgs>): CommonArgs {
  return {
    stackNames: [],
    all: false,
    region: 'us-east-1',
    profile: undefined,
    app: undefined,
    context: {},
    json: false,
    showAll: false,
    yes: false,
    preDeploy: false,
    undeclaredOnly: false,
    declaredOnly: false,
    fail: false,
    strict: false,
    removeUnrecorded: false,
    force: false,
    verbose: false,
    waitMs: undefined,
    ...overrides,
  };
}

describe('resolveStacks — staged-stack selector accepts both identifier forms (#1316)', () => {
  beforeEach(() => {
    stagedErrors = [];
  });

  it('check Dev/Net (cdk-native hierarchicalId form) resolves the staged stack', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev/Net'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev-Net']);
  });

  it('check Dev-Net (deployed stackName form) resolves the staged stack', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev-Net'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev-Net']);
  });

  it('Dev/* glob matches the staged stack', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev/*'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev-Net']);
  });

  it('Dev-* glob (stackName form) still matches the staged stack', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev-*'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev-Net']);
  });

  it('a bogus positional lists both identifier forms in the error', async () => {
    await expect(resolveStacks(args({ stackNames: ['Nope'] }))).rejects.toThrow(
      /Dev\/Net \(Dev-Net\)/
    );
  });
});

describe('resolveStacks — a stackName-form positional still surfaces the addError (#1316)', () => {
  beforeEach(() => {
    stagedErrors = [];
  });

  it('check Dev-Net aborts on the staged stack error annotation (validation not silently skipped)', async () => {
    stagedErrors = ['THIS STACK IS BROKEN'];
    // The bug: `Dev-Net` matches zero hierarchicalIds, so toolkit.synth's metadata validation is
    // skipped and the broken app is read/reverted. The fix re-checks the selected stack's errors.
    await expect(resolveStacks(args({ stackNames: ['Dev-Net'] }))).rejects.toThrow(
      /Dev-Net: THIS STACK IS BROKEN/
    );
  });

  it('check Dev/Net (hierarchicalId form) also aborts on the error annotation', async () => {
    stagedErrors = ['THIS STACK IS BROKEN'];
    await expect(resolveStacks(args({ stackNames: ['Dev/Net'] }))).rejects.toThrow(
      /THIS STACK IS BROKEN/
    );
  });

  it('no-args (all stacks selected) aborts on a staged stack error too', async () => {
    stagedErrors = ['THIS STACK IS BROKEN'];
    await expect(resolveStacks(args({ stackNames: [] }))).rejects.toThrow(/THIS STACK IS BROKEN/);
  });

  it('a clean staged stack resolves normally (no false abort)', async () => {
    const out = await resolveStacks(args({ stackNames: ['Dev-Net'] }));
    expect(out.map((s) => s.stackName)).toEqual(['Dev-Net']);
  });
});

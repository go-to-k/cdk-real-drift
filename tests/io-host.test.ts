import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { IoMessage } from '@aws-cdk/toolkit-lib';
import { planIoMessage, QuietIoHost } from '../src/synth/io-host.js';

describe('planIoMessage (QuietIoHost routing)', () => {
  it('re-tags CDK app stderr passthrough (E1002, error) to info so it is not red', () => {
    // toolkit-lib relays the app subprocess stderr (bundling progress) as an ERROR;
    // we downgrade to info so it prints in the default color, matching cdk-local.
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_E1002', level: 'error' })).toEqual({
      action: 'emit',
      level: 'info',
    });
  });

  it('re-tags CDK app stdout passthrough (I1001) to info (default color)', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I1001', level: 'info' })).toEqual({
      action: 'emit',
      level: 'info',
    });
  });

  it('re-tags the construct-annotation validation report (E9600, error) to warn so the whole block is yellow, not red', () => {
    // toolkit-lib registers the Construct Annotations validation report at ERROR level
    // even when it only carries WARNINGS; the default IoHost would then wrap it in red.
    // We re-tag to warn so the block is yellow to match its own WARNING label (and like
    // every other cdkrd synth warning), rather than the misleading error red.
    expect(planIoMessage({ code: 'CDK_TOOLKIT_E9600', level: 'error' })).toEqual({
      action: 'emit',
      level: 'warn',
    });
  });

  it('still surfaces a REAL toolkit error unchanged (stays red)', () => {
    // a genuine synth failure (not the app-stderr passthrough) keeps its error level
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_E1111', level: 'error' })).toEqual({
      action: 'emit',
      level: 'error',
    });
  });

  it('still surfaces warnings', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_W0010', level: 'warn' })).toEqual({
      action: 'emit',
      level: 'warn',
    });
  });

  it('surfaces the context-lookup FETCH (I0241, debug) as an info one-liner (#906)', () => {
    // toolkit-lib registers I0241 at DEBUG, so it would otherwise be dropped, leaving the
    // read-only `check` to hit AWS silently. Note it as a concise info line.
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I0241', level: 'debug' })).toMatchObject({
      action: 'note',
      level: 'info',
    });
  });

  it('surfaces the cdk.context.json WRITE (I0042, debug) as an info one-liner (#906)', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I0042', level: 'debug' })).toMatchObject({
      action: 'note',
      level: 'info',
    });
  });

  it('drops toolkit info / debug / trace chatter', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I0010', level: 'info' })).toEqual({
      action: 'drop',
    });
    expect(planIoMessage({ code: 'CDK_TOOLKIT_I0001', level: 'debug' })).toEqual({
      action: 'drop',
    });
    expect(planIoMessage({ code: undefined, level: 'trace' })).toEqual({ action: 'drop' });
  });
});

describe('QuietIoHost surfaces context-lookup + cdk.context.json write (#906)', () => {
  // Build a minimal IoMessage. code/level are the only fields planIoMessage inspects;
  // message is what the base host renders.
  const msg = (
    code: string | undefined,
    level: string,
    message = 'toolkit body'
  ): IoMessage<unknown> =>
    ({
      code,
      level,
      message,
      time: new Date(),
    }) as unknown as IoMessage<unknown>;

  it('emits ONE info line to stderr for I0241 (fetching), de-duped across repeats', async () => {
    const host = new QuietIoHost();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await host.notify(msg('CDK_ASSEMBLY_I0241', 'debug'));
      // fires again in a later resolution round — must NOT print a second line
      await host.notify(msg('CDK_ASSEMBLY_I0241', 'debug'));
    } finally {
      spy.mockRestore();
    }
    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('context lookups');
    expect(lines[0]).not.toContain('toolkit body'); // our concise text, not the verbose debug body
  });

  it('emits an info line to stderr for I0042 (cdk.context.json write)', async () => {
    const host = new QuietIoHost();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await host.notify(msg('CDK_ASSEMBLY_I0042', 'debug'));
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('cdk.context.json');
  });

  it('still DROPS a below-warn message with a different code (no stderr write)', async () => {
    const host = new QuietIoHost();
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const eSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrWrites.push(String(c));
      return true;
    });
    const oSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutWrites.push(String(c));
      return true;
    });
    try {
      await host.notify(msg('CDK_ASSEMBLY_I0010', 'debug'));
      await host.notify(msg('CDK_TOOLKIT_I0001', 'info'));
    } finally {
      eSpy.mockRestore();
      oSpy.mockRestore();
    }
    expect(stderrWrites.join('')).toBe('');
    expect(stdoutWrites.join('')).toBe('');
  });
});

describe('QuietIoHost pins non-error output to stderr even under CI (#867)', () => {
  const saved = process.env.CI;
  beforeEach(() => {
    // GitHub Actions sets CI=true; the base NonInteractiveIoHost would then route all
    // non-error messages to STDOUT, polluting `check --json`. Simulate that environment.
    process.env.CI = 'true';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CI;
    else process.env.CI = saved;
  });

  it('isCI is false regardless of process.env.CI', () => {
    expect(new QuietIoHost().isCI).toBe(false);
  });

  it('info / warn (synth passthrough) select stderr, not stdout, under CI', () => {
    const host = new QuietIoHost();
    // selectStreamFromLevel is the base method the CI redirect lives in; cast to reach it.
    const select = (level: string): unknown =>
      (host as unknown as { selectStreamFromLevel: (l: string) => unknown }).selectStreamFromLevel(
        level
      );
    expect(select('info')).toBe(process.stderr);
    expect(select('warn')).toBe(process.stderr);
    // a real error still goes to stderr (unchanged), and the toolkit's own `result`
    // level still goes to stdout — but cdkrd never emits `result` through this host.
    expect(select('error')).toBe(process.stderr);
    expect(select('result')).toBe(process.stdout);
  });
});

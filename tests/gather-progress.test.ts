import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// A stub spinner so we can assert start/stop are (or are not) driven by
// gatherWithProgress without a real TTY animation.
const start = vi.fn();
const stop = vi.fn();
const error = vi.fn();
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spinner: () => ({ start, stop, error, message: vi.fn() }) };
});

import { gatherWithProgress } from '../src/commands/check.js';
import type { GatherResult } from '../src/commands/gather.js';

// A minimal GatherResult — gatherWithProgress only forwards it, never inspects it.
const RESULT = {
  desired: {},
  findings: [],
  schemas: new Map(),
  liveByLogical: new Map(),
} as unknown as GatherResult;

describe('gatherWithProgress', () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
    error.mockClear();
  });

  it('is a plain pass-through when show=false (no spinner)', async () => {
    const run = vi.fn().mockResolvedValue(RESULT);
    const out = await gatherWithProgress(false, 'S (r)', run);
    expect(out).toBe(RESULT);
    expect(run).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('starts and stops the spinner around the run when show=true', async () => {
    const run = vi.fn().mockResolvedValue(RESULT);
    const out = await gatherWithProgress(true, 'S (r)', run);
    expect(out).toBe(RESULT);
    expect(start).toHaveBeenCalledOnce();
    // success path: stop (not error), carrying the stack label.
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]![0]).toContain('S (r)');
    expect(error).not.toHaveBeenCalled();
  });

  it('tears the spinner down via error() and rethrows on failure', async () => {
    const boom = new Error('read blew up');
    const run = vi.fn().mockRejectedValue(boom);
    await expect(gatherWithProgress(true, 'S (r)', run)).rejects.toThrow('read blew up');
    // failure symbol shown, success stop NOT called, so the outer catch prints cleanly.
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('S (r)');
    expect(stop).not.toHaveBeenCalled();
  });
});

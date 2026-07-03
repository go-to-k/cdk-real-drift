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

import {
  gatherWithProgress,
  positionPrefix,
  progressLabel,
  stackCountAnnouncement,
} from '../src/commands/progress.js';

// gatherWithProgress is generic and only forwards its run() result — a sentinel object
// is enough to assert pass-through.
const RESULT = { sentinel: true };

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

describe('progressLabel', () => {
  it('omits the counter for a lone stack (a bare [1/1] is noise)', () => {
    expect(progressLabel(0, 1, 'MyStack', 'us-east-1')).toBe('MyStack (us-east-1)');
  });

  it('prefixes a 1-based [idx/total] counter in a multi-stack run', () => {
    expect(progressLabel(0, 3, 'A', 'ap-northeast-1')).toBe('[1/3] A (ap-northeast-1)');
    expect(progressLabel(2, 3, 'C', 'ap-northeast-1')).toBe('[3/3] C (ap-northeast-1)');
  });
});

describe('positionPrefix (issue #539 — the [i/N] cue shared by spinner/header/prompt)', () => {
  it('is empty for a lone stack (a bare [1/1] is noise)', () => {
    expect(positionPrefix(0, 1)).toBe('');
  });

  it('is a 1-based [idx/total] with a trailing space in a multi-stack run', () => {
    expect(positionPrefix(0, 3)).toBe('[1/3] ');
    expect(positionPrefix(1, 3)).toBe('[2/3] ');
    expect(positionPrefix(2, 3)).toBe('[3/3] ');
  });

  it('agrees with the spinner label prefix (all three cues stay consistent)', () => {
    expect(`${positionPrefix(1, 3)}S (r)`).toBe(progressLabel(1, 3, 'S', 'r'));
  });
});

describe('stackCountAnnouncement (issue #539 — up-front total)', () => {
  it('is null for a lone stack (nothing to announce)', () => {
    expect(stackCountAnnouncement(['Only'])).toBeNull();
  });

  it('is null for zero stacks', () => {
    expect(stackCountAnnouncement([])).toBeNull();
  });

  it('lists the count and names for a multi-stack run', () => {
    expect(stackCountAnnouncement(['A', 'B', 'C'])).toBe('note: checking 3 stack(s): A, B, C');
  });
});

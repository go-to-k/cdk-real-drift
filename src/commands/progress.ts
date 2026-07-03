// Shared gather-phase progress spinner for the four verbs (check / record / ignore /
// revert). Each of them reads a stack's full live state + computes the diff via
// `gatherFindings`, which runs SILENTLY and can take many seconds on a large stack —
// long enough that a run looks frozen before the first output, and (in a multi-stack
// run) in the gap between one stack's interactive prompt and the next stack's turn,
// where the user has no cue anything is happening. Show a spinner while it runs so it is
// clear cdkrd is working, not hung.
import { spinner } from '@clack/prompts';

// TTY + text mode only: a spinner would corrupt --json's machine stdout and is noise in
// a non-TTY / CI pipe, so callers pass `show=false` there and this is a plain
// pass-through. Stopped on BOTH success (`stop`) and error (`error`, which renders the
// failure symbol) so a throw still tears the animation down before the caller's catch
// prints its message. Generic in the gather result so every verb (which unpacks the
// result differently) can wrap its own `gatherFindings` call unchanged.
export async function gatherWithProgress<T>(
  show: boolean,
  label: string,
  run: () => Promise<T>
): Promise<T> {
  if (!show) return run();
  const s = spinner();
  s.start(`${label}: reading live AWS state & computing drift…`);
  try {
    const gathered = await run();
    s.stop(`${label}: live state read`);
    return gathered;
  } catch (e) {
    s.error(`${label}: read failed`);
    throw e;
  }
}

// The `[2/3] ` position cue shared by the spinner label, the report header, and the
// interactive resolve prompt (issue #539) so all three agree on "which stack of how
// many". Empty for a lone stack (a bare `[1/1]` is noise). `idx` is the 0-based
// position, `total` the number of stacks being processed. Pure + exported for tests.
export function positionPrefix(idx: number, total: number): string {
  return total > 1 ? `[${idx + 1}/${total}] ` : '';
}

// The per-stack spinner label: `[2/3] Stack (region)` in a multi-stack run, or just
// `Stack (region)` for a lone stack. `idx` is the 0-based position, `total` the number
// of stacks being processed.
export function progressLabel(
  idx: number,
  total: number,
  stackName: string,
  region: string
): string {
  return `${positionPrefix(idx, total)}${stackName} (${region})`;
}

// The up-front "checking N stacks" announcement (issue #539): emitted once before the
// per-stack loop so the user knows the total (and which stacks) at the start, not only
// embedded inside the scrolled-away `[i/N]` spinner line. Only meaningful with >1 stack
// — a lone stack returns null (consistent with the `[1/1]`-is-noise rule). Pure +
// exported for tests; the caller gates on `--json` (stderr must not pollute JSON stdout).
export function stackCountAnnouncement(stackNames: string[]): string | null {
  if (stackNames.length <= 1) return null;
  return `note: checking ${stackNames.length} stack(s): ${stackNames.join(', ')}`;
}

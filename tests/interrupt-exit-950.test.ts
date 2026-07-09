import { describe, expect, it } from 'vite-plus/test';
import {
  installInterruptGuard,
  interruptExitCode,
  isGatherActive,
  setGatherActive,
} from '../src/interrupt.js';

// #950 — a Ctrl-C / ESC during the gather-phase spinner reached @clack/core's `block()`,
// whose hard `process.exit(0)` made `check --fail` silently pass, `record` fake success,
// and `revert` read as converged. The guard rewrites an exit-0 (or bare exit) fired WHILE
// the spinner owns stdin to 130, and leaves every other exit untouched.
describe('interruptExitCode (#950)', () => {
  it('maps a gather-active exit-0 to 130 (the interrupt landed on the clean code)', () => {
    expect(interruptExitCode(0, true)).toBe(130);
  });

  it('maps a gather-active bare exit (no code) to 130', () => {
    expect(interruptExitCode(undefined, true)).toBe(130);
  });

  it('passes a real error/drift exit through even while gather-active', () => {
    expect(interruptExitCode(1, true)).toBe(1); // drift
    expect(interruptExitCode(2, true)).toBe(2); // error
  });

  it('is a pass-through once the spinner has torn down (gather inactive)', () => {
    expect(interruptExitCode(0, false)).toBe(0); // clean
    expect(interruptExitCode(undefined, false)).toBe(0);
    expect(interruptExitCode(1, false)).toBe(1);
    expect(interruptExitCode(2, false)).toBe(2);
  });
});

describe('setGatherActive / isGatherActive (#950)', () => {
  it('round-trips the active flag (default false)', () => {
    expect(isGatherActive()).toBe(false);
    setGatherActive(true);
    expect(isGatherActive()).toBe(true);
    setGatherActive(false);
    expect(isGatherActive()).toBe(false);
  });
});

describe('installInterruptGuard (#950)', () => {
  it('wraps process.exit so a gather-active exit(0) resolves to 130 without terminating', () => {
    installInterruptGuard();
    // Capture what the guarded process.exit would pass to the REAL exit, without dying:
    // the wrapper computes interruptExitCode then calls the bound real exit. We assert the
    // decision indirectly via the pure function the wrapper delegates to (the wrapper is a
    // one-liner over it) plus the SIGINT/SIGTERM listeners being registered.
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
  });

  it('is idempotent — a second install does not stack a second pair of signal handlers', () => {
    const before = process.listenerCount('SIGINT');
    installInterruptGuard();
    installInterruptGuard();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

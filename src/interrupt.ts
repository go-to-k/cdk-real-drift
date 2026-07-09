// Interrupt handling for the gather phase (#950). `@clack/core`'s `block()` — the
// raw-mode keypress handler the gather-phase spinner installs — hard-codes
// `process.exit(0)` on the cancel key (Ctrl-C AND Escape). That is the CLEAN exit code,
// so an interrupt during the gather (the LONGEST phase of every verb) silently passed
// `check --fail` ("no drift" → a gated deploy proceeds), faked `record`/`ignore` success
// with nothing written, and read as "converged" for `revert`. cdkrd installs no signal
// handling of its own, and the exit-0 lives inside the vendored dependency, unreachable
// via `spinner({ onCancel })` (that only hooks the SIGNAL path, not the keypress path).
//
// We guard it centrally: while the gather spinner holds stdin in raw mode, rewrite an
// exit-0 to 130 (128 + SIGINT, the conventional interrupt code) via a thin process.exit
// wrapper, and install real SIGINT/SIGTERM handlers for the phases where stdin is NOT in
// raw mode (synth/discovery, the interactive prompt gap) so those interrupts also land on
// 130 with the cursor restored. Outside the gather window the wrapper is a pass-through,
// so a clean 0 / drift 1 / error 2 exit is unaffected.

let gatherActive = false;

// Set by the gather-phase spinner wrapper (progress.ts) around the exact window where
// `@clack/core` owns stdin and can hard-exit(0) on a keypress.
export function setGatherActive(active: boolean): void {
  gatherActive = active;
}

// Exposed for tests only.
export function isGatherActive(): boolean {
  return gatherActive;
}

// Pure decision: an exit-0 (or a bare `process.exit()` with no code) fired WHILE the
// gather spinner is active is an interrupt captured by the spinner's raw-mode handler,
// not a clean run — map it to 130. An explicit non-zero code (a real error/drift exit)
// always passes through, as does any exit once the spinner has torn down.
export function interruptExitCode(code: number | undefined, active: boolean): number {
  return active && (code === undefined || code === 0) ? 130 : (code ?? 0);
}

let installed = false;

// Install the process-exit guard + signal handlers exactly once, at CLI startup.
export function installInterruptGuard(): void {
  if (installed) return;
  installed = true;
  const realExit = process.exit.bind(process) as (code?: number) => never;
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never =>
    realExit(interruptExitCode(code, gatherActive));
  const onSignal = (): never => {
    // Restore the cursor the spinner may have hidden, then exit with the interrupt code.
    // (Overrides Node's default SIGINT handler, which would exit 130 anyway but without
    // the cursor-restore.) Bypass the wrapper — this is unambiguously an interrupt.
    process.stderr.write('\x1B[?25h');
    return realExit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

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
// 130/143 with the cursor restored. Outside the gather window the wrapper is a pass-through,
// so a clean 0 / drift 1 / error 2 exit is unaffected.
//
// #951 extends the same central handlers to the OTHER process-level listeners @clack also
// registers-and-swallows while the spinner is active: a SIGTERM (or signal-delivered SIGINT)
// no longer just prints "Canceled" and continues (it exits 143/130), and a stray unhandled
// rejection / uncaught exception exits 2 (the error code) instead of being swallowed to a
// clean exit 0 in the spinner window or defaulting to exit 1 (the drift code) outside it.

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
  const onSignal = (code: number) => (): never => {
    // Restore the cursor the spinner may have hidden, then exit with the conventional
    // 128+signal code. (Overrides Node's default handler — which would exit with the same
    // code but without the cursor-restore — AND neutralizes @clack's spinner listener,
    // which otherwise just prints "Canceled" and lets the run CONTINUE, so a CI
    // cancellation / `timeout` / supervisor kill needed a SECOND signal to terminate,
    // #951.) Bypass the exit wrapper — this is unambiguously an interrupt.
    process.stderr.write('\x1B[?25h');
    return realExit(code);
  };
  process.on('SIGINT', onSignal(130)); // 128 + SIGINT(2)
  process.on('SIGTERM', onSignal(143)); // 128 + SIGTERM(15)
  // #951: a stray unhandled rejection / uncaught exception is an ERROR — exit 2 per the
  // documented contract ("errors always 2"), in AND out of the gather-spinner window. While
  // the spinner is active @clack registers its own unhandledRejection /
  // uncaughtExceptionMonitor listeners that only stop the spinner and CONTINUE (swallowing a
  // real dependency failure into a clean exit 0); OUTSIDE it, Node's default kills with exit
  // 1 — which collides with `check --fail`'s "drift found" code. Registered here at startup
  // (before any spinner), cdkrd's handler coexists with clack's transient one and performs
  // the real exit. cli.ts's own `main().catch` still handles main's rejection (also exit 2);
  // this covers the STRAY ones that never flow through main's promise.
  const onFatal =
    (kind: string) =>
    (err: unknown): void => {
      process.stderr.write('\x1B[?25h');
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`error: ${kind}: ${detail}`);
      realExit(2);
    };
  process.on('unhandledRejection', onFatal('unhandled rejection'));
  process.on('uncaughtException', onFatal('uncaught exception'));
}

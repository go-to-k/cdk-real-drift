// Process-exit helpers. `process.exit()` does NOT drain pending async writes on a PIPED
// stdout — Node discards whatever exceeds the OS pipe buffer (~64 KiB). A large
// `check --all --json` document (policy documents in desired/actual) easily exceeds that,
// so `cdkrd check --json | jq` / `> report.json` in CI received a TRUNCATED, unparseable
// half-document while the exit code still read 0/1 as normal (and text mode's `^result:`
// grep could be cut mid-stream). We drain both std streams before exiting. (#866)

// Resolve once the stream's write queue is flushed. Writes on a stream are ordered, so a
// trailing zero-length write's callback fires only AFTER every prior chunk has reached the
// pipe — awaiting it drains the buffer. Resolve immediately when nothing is buffered (or
// the stream is already ended), and NEVER reject: an EPIPE from a reader that closed early
// must not become an unhandled rejection that masks the real exit code.
export function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0 || stream.writableEnded) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
  });
}

// Flush stdout + stderr, then exit with `code`. This replaces a bare `process.exit(code)`
// so a piped, larger-than-64-KiB payload is delivered whole instead of truncated.
export async function flushAndExit(code: number): Promise<never> {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}

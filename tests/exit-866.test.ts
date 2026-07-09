import { describe, expect, it, vi } from 'vite-plus/test';
import { drain } from '../src/exit.js';

// #866: process.exit() truncates a PIPED stdout at the OS pipe buffer because it does not
// drain pending async writes. `drain` fixes that by awaiting the stream's write queue — a
// trailing zero-length write's callback fires only after every prior chunk has flushed.
// These tests pin drain's contract with a fake WriteStream so the pipe mechanics are
// deterministic (the real >64 KiB truncation is covered end-to-end by the live-test).

interface FakeStream {
  writableLength: number;
  writableEnded: boolean;
  write: (chunk: string, cb: () => void) => void;
}

describe('drain (#866 — flush before exit)', () => {
  it('resolves WITHOUT writing when nothing is buffered', async () => {
    const write = vi.fn();
    const s: FakeStream = { writableLength: 0, writableEnded: false, write };
    await drain(s as unknown as NodeJS.WriteStream);
    expect(write).not.toHaveBeenCalled(); // no spurious write on an empty buffer
  });

  it('resolves WITHOUT writing when the stream is already ended', async () => {
    const write = vi.fn();
    const s: FakeStream = { writableLength: 999, writableEnded: true, write };
    await drain(s as unknown as NodeJS.WriteStream);
    expect(write).not.toHaveBeenCalled();
  });

  it('waits for the flush callback before resolving when data is buffered', async () => {
    let flush: (() => void) | undefined;
    const write = vi.fn((_chunk: string, cb: () => void) => {
      flush = cb; // capture the callback; do NOT fire it yet
    });
    const s: FakeStream = { writableLength: 70_000, writableEnded: false, write };

    let resolved = false;
    const p = drain(s as unknown as NodeJS.WriteStream).then(() => {
      resolved = true;
    });

    // A zero-length write is queued but its callback has not fired → drain must NOT resolve
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toBe(''); // a trailing empty write, ordered after prior chunks
    expect(resolved).toBe(false);

    // Once the buffer flushes (callback fires), drain resolves.
    flush!();
    await p;
    expect(resolved).toBe(true);
  });
});

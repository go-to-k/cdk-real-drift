import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// #951 — while the gather spinner is active @clack registers its own
// SIGINT/SIGTERM/unhandledRejection/uncaughtException listeners that only stop the spinner
// and CONTINUE (swallowing the failure), and cdkrd itself registered none for the
// error/signal lanes. Building on #950's guard, a stray unhandled rejection / uncaught
// exception now exits 2 (the error code) and SIGTERM exits 143.
//
// Everything is verified in a CHILD process: installInterruptGuard() hijacks process.exit
// and installs process-global unhandledRejection/uncaughtException handlers, so calling it
// inside the vitest process would make a stray rejection anywhere tear the runner down.
// interrupt.ts has no relative imports, so node's type-stripping imports it directly.
const here = dirname(fileURLToPath(import.meta.url));
const interruptTs = join(here, '..', 'src', 'interrupt.ts');
const runChild = (body: string): ReturnType<typeof spawnSync> => {
  const script = `const { installInterruptGuard } = await import(${JSON.stringify(interruptTs)});\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '--experimental-strip-types', '-'], {
    input: script,
    encoding: 'utf8',
  });
};

describe('#951 fatal/interrupt lanes (child-process, end to end)', () => {
  it('a stray unhandled rejection exits 2 with error on stderr (not swallowed to 0, not the drift 1)', () => {
    const r = runChild(`
      installInterruptGuard();
      Promise.reject(new Error('stray rejection during gather'));
      setTimeout(() => { console.log('SHOULD NOT PRINT'); }, 300);
    `);
    expect(r.status).toBe(2);
    expect(`${r.stdout}`).not.toContain('SHOULD NOT PRINT');
    expect(`${r.stderr}`).toMatch(/error: unhandled rejection: .*stray rejection/);
  });

  it('a stray uncaught exception exits 2', () => {
    const r = runChild(`
      installInterruptGuard();
      setTimeout(() => { throw new Error('boom uncaught'); }, 10);
    `);
    expect(r.status).toBe(2);
    expect(`${r.stderr}`).toMatch(/error: uncaught exception: .*boom uncaught/);
  });

  it('registers the fatal + signal handlers, idempotently', () => {
    const r = runChild(`
      installInterruptGuard();
      installInterruptGuard(); // second call must not stack more listeners
      const c = {
        rej: process.listenerCount('unhandledRejection'),
        exc: process.listenerCount('uncaughtException'),
        int: process.listenerCount('SIGINT'),
        term: process.listenerCount('SIGTERM'),
      };
      process.stdout.write(JSON.stringify(c));
      process.exit(0);
    `);
    const c = JSON.parse(`${r.stdout}`) as Record<string, number>;
    expect(c.rej).toBe(1);
    expect(c.exc).toBe(1);
    expect(c.int).toBe(1);
    expect(c.term).toBe(1);
  });

  it('a clean run is unaffected — exit 0 passes through the guard', () => {
    const r = runChild(`
      installInterruptGuard();
      console.log('clean');
      process.exit(0);
    `);
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toContain('clean');
  });
});

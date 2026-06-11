import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// R38: interactivity flows through the single `isInteractive(args)` helper in
// cli-args.ts. Command code must NOT read `process.stdin.isTTY` directly — only
// cli-args.ts may. This guards against a new prompt re-introducing a raw TTY check
// that would ignore `--no-interactive`.
const COMMAND_FILES = [
  '../src/commands/check.ts',
  '../src/commands/accept.ts',
  '../src/commands/revert.ts',
  '../src/commands/stack-actions.ts',
];

describe('no direct process.stdin.isTTY in command code (R38)', () => {
  for (const rel of COMMAND_FILES) {
    it(`${rel} does not read stdin.isTTY directly`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src).not.toContain('stdin.isTTY');
    });
  }

  it('the helper lives in cli-args.ts', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/cli-args.ts', import.meta.url)), 'utf8');
    expect(src).toContain('stdin.isTTY');
    expect(src).toContain('export function isInteractive');
  });
});

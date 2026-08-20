import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// R38: interactivity flows through the single `isInteractive()` helper in
// cli-args.ts. Everything else must NOT read the stdin TTY state directly — only
// cli-args.ts may. This keeps the TTY check in ONE place (non-interactive simply
// means non-TTY since R58) so its semantics can never fork per command.
//
// Both halves of this fence were probed on 2026-08-20 and both were wrong:
//
// - POPULATION. It listed FOUR files by hand while `src/commands/` holds 14,
//   so `ignore.ts` — one of the four verbs — could read `stdin.isTTY` with the
//   fence green. It is now the whole of `src/**`, minus the one owner, which is
//   also the population the rule states.
// - SPELLING. It matched the literal `stdin.isTTY` only, so `process.stdin['isTTY']`,
//   a destructured `const { isTTY } = process.stdin`, and `isatty(0)` from
//   `node:tty` all passed. Each is now a signature of its own.
const OWNER = path.join('src', 'cli-args.ts');

/** Every way to reach the stdin TTY state that does not go through the helper. */
const SIGNATURES: { label: string; test: (src: string) => boolean }[] = [
  { label: 'stdin.isTTY', test: (s) => s.includes('stdin.isTTY') },
  { label: "stdin['isTTY']", test: (s) => /stdin\s*\[\s*['"]isTTY['"]\s*\]/.test(s) },
  {
    label: 'destructured isTTY from process.stdin',
    test: (s) => /\{[^}]*\bisTTY\b[^}]*\}\s*=\s*process\.stdin/.test(s),
  },
  { label: 'node:tty isatty()', test: (s) => /from\s+['"]node:tty['"]|\bisatty\s*\(/.test(s) },
];

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no direct stdin TTY reads outside cli-args.ts (R38)', () => {
  const files = sourceFiles(SRC);

  it('walks the whole src tree, not a hand-kept list', () => {
    const rels = files.map((f) => path.relative(path.join(SRC, '..'), f));
    expect(rels).toContain(path.join('src', 'commands', 'check.ts'));
    expect(rels).toContain(path.join('src', 'commands', 'ignore.ts'));
    expect(rels.length).toBeGreaterThan(20);
  });

  it('no file but cli-args.ts reaches the stdin TTY state, in any spelling', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(path.join(SRC, '..'), file);
      if (rel === OWNER) continue;
      const src = readFileSync(file, 'utf8');
      for (const sig of SIGNATURES) {
        if (sig.test(src)) offenders.push(`${rel}: ${sig.label}`);
      }
    }
    expect(offenders, 'route the check through isInteractive() in src/cli-args.ts instead').toEqual(
      []
    );
  });

  it('every signature flags its own spelling (spelling probe)', () => {
    const samples = [
      'const i = process.stdin.isTTY === true;',
      "const i = process.stdin['isTTY'] === true;",
      'const { isTTY } = process.stdin;',
      "import { isatty } from 'node:tty';",
    ];
    for (const sample of samples) {
      expect(SIGNATURES.filter((s) => s.test(sample)).length, sample).toBeGreaterThanOrEqual(1);
    }
    expect(SIGNATURES.filter((s) => s.test('const tty = renderTable(rows);')).length).toBe(0);
  });

  it('the helper lives in cli-args.ts', () => {
    const src = readFileSync(path.join(SRC, 'cli-args.ts'), 'utf8');
    expect(src).toContain('stdin.isTTY');
    expect(src).toContain('export function isInteractive');
  });
});

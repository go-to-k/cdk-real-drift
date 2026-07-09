// #943 / #988 / #989 — the "never empty bytes" JSON contract on a whole-run failure.
// Under `--json`, every verb must leave stdout a single JSON.parse-able value (`[]`) even
// when the run fails before any stack is reached, so a CI consumer's JSON.parse(stdout)
// never throws on ''. Two failure classes were leaking empty stdout:
//
//   #943/#989: parseCommonArgs() runs at the TOP of each run*, OUTSIDE any try/catch, and
//              throws on a bad flag. The throw escaped to cli.ts's main().catch, which had
//              no --json awareness → empty stdout. Fixed centrally in cli.ts.
//   #988:      each verb's FIRST early catch (loadConfig) forgot the `[]` emit the sibling
//              resolveStacks catch already had. A malformed .cdkrd/ignore.yaml therefore
//              left stdout empty. Fixed per-verb.
//
// Both live at the PROCESS level (the central catch is module-top-level in cli.ts; the
// loadConfig throw needs a real bad config on disk), so we exercise the BUILT CLI end to
// end — run `vp pack` before `vp test run`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // no AWS is reached — both failure classes short-circuit before any network call
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const VERBS = ['record', 'ignore', 'revert'] as const;

describe('--json emits [] (never empty stdout) on a whole-run failure (#943/#988/#989)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // #943/#989 — parseCommonArgs throws on an unknown option, escaping run* to main().catch.
  describe('a bad flag (parseCommonArgs throw) still yields stdout "[]" and exit 2', () => {
    for (const verb of [...VERBS, 'check'] as const) {
      it(`${verb} --json --bogus`, () => {
        const { status, stdout, stderr } = run([verb, '--json', '--bogus']);
        expect(status).toBe(2);
        expect(JSON.parse(stdout)).toEqual([]); // parseable, never ''
        expect(stdout.trim()).toBe('[]');
        expect(stderr).toContain('unknown option'); // reason still on stderr
      });
    }

    it('text mode (no --json) leaves stdout empty on the same bad flag', () => {
      const { status, stdout, stderr } = run(['record', '--bogus']);
      expect(status).toBe(2);
      expect(stdout).toBe(''); // no stray stdout without --json
      expect(stderr).toContain('unknown option');
    });
  });

  // #988 — a malformed .cdkrd/ignore.yaml makes loadConfig() throw; the FIRST early catch
  // must emit [] under --json just like the sibling resolveStacks catch.
  describe('a malformed .cdkrd/ignore.yaml (loadConfig throw) still yields stdout "[]" and exit 2', () => {
    function badConfigDir(): string {
      const dir = mkdtempSync(join(tmpdir(), 'cdkrd-json-'));
      dirs.push(dir);
      mkdirSync(join(dir, '.cdkrd'), { recursive: true });
      writeFileSync(join(dir, '.cdkrd', 'ignore.yaml'), 'ignores:\n  - {\n'); // unbalanced → YAML parse error
      return dir;
    }

    for (const verb of VERBS) {
      it(`${verb} --json under a broken ignore.yaml`, () => {
        const { status, stdout, stderr } = run([verb, '--json'], badConfigDir());
        expect(status).toBe(2);
        expect(JSON.parse(stdout)).toEqual([]);
        expect(stdout.trim()).toBe('[]');
        expect(stderr).toMatch(/error:/);
      });
    }

    it('text mode leaves stdout empty under the same broken config', () => {
      const { status, stdout } = run(['record'], badConfigDir());
      expect(status).toBe(2);
      expect(stdout).toBe('');
    });
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { shouldRemoveEmptyContextFile } from '../src/synth/synth.js';

// The empty-file guard for #906: a read-only `check` must never leave an empty `{}`
// cdk.context.json (an all-failed lookup) in the user's tree, but must NEVER delete a
// pre-existing or non-empty file. shouldRemoveEmptyContextFile encodes the existence half
// of that guard; the emptiness check is exercised against a real file below.

describe('shouldRemoveEmptyContextFile (#906)', () => {
  it('removes only a file synth JUST created (did not exist before, exists now)', () => {
    expect(shouldRemoveEmptyContextFile(false, true)).toBe(true);
  });

  it('never touches a file that pre-existed the synth', () => {
    // a user's committed cdk.context.json — even if we later saw it, we did not create it
    expect(shouldRemoveEmptyContextFile(true, true)).toBe(false);
  });

  it('is a no-op when no file exists after synth', () => {
    expect(shouldRemoveEmptyContextFile(false, false)).toBe(false);
    expect(shouldRemoveEmptyContextFile(true, false)).toBe(false);
  });
});

// Model the full cleanup contract (create-check + emptiness) against a real temp dir, so
// the guard against clobbering a user's real context file is covered end to end.
describe('empty-context cleanup contract (#906)', () => {
  const dirs: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'cdkrd-ctx-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Mirror of the private cleanup logic in synth.ts, kept in sync via the exported guard.
  const isEmpty = (raw: string): boolean => {
    const t = raw.trim();
    if (t === '' || t === '{}') return true;
    try {
      const p: unknown = JSON.parse(t);
      return (
        typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0
      );
    } catch {
      return false;
    }
  };
  const cleanup = (file: string, existedBefore: boolean): void => {
    if (!shouldRemoveEmptyContextFile(existedBefore, existsSync(file))) return;
    if (isEmpty(readFileSync(file, 'utf-8'))) rmSync(file);
  };

  it('deletes a newly-created empty {} file', () => {
    const dir = mk();
    const file = join(dir, 'cdk.context.json');
    const existedBefore = existsSync(file); // false
    writeFileSync(file, '{}\n');
    cleanup(file, existedBefore);
    expect(existsSync(file)).toBe(false);
  });

  it('KEEPS a newly-created file that captured real lookup results', () => {
    const dir = mk();
    const file = join(dir, 'cdk.context.json');
    const existedBefore = existsSync(file); // false
    writeFileSync(file, JSON.stringify({ 'vpc-provider:account=1': { vpcId: 'vpc-abc' } }));
    cleanup(file, existedBefore);
    expect(existsSync(file)).toBe(true);
  });

  it('NEVER deletes a pre-existing user file, even if it is empty {}', () => {
    const dir = mk();
    const file = join(dir, 'cdk.context.json');
    writeFileSync(file, '{}');
    const existedBefore = existsSync(file); // true — user committed it
    cleanup(file, existedBefore);
    expect(existsSync(file)).toBe(true);
  });

  it('NEVER deletes a pre-existing non-empty user file', () => {
    const dir = mk();
    const file = join(dir, 'cdk.context.json');
    writeFileSync(file, JSON.stringify({ 'hosted-zone:account=1': { Id: 'Z123' } }));
    const existedBefore = existsSync(file); // true
    cleanup(file, existedBefore);
    expect(existsSync(file)).toBe(true);
  });
});

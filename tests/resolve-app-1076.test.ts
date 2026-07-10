import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { resolveApp } from '../src/synth/resolve-app.js';

// #1076 — resolveApp used a bare `readFileSync('cdk.json','utf8')` + `JSON.parse` inside a
// swallow-all `catch {}`, so a cdk.json with a UTF-8 BOM / UTF-16 encoding (common Windows
// tooling output that the real `cdk` accepts) or a syntax error returned `undefined`, which
// callers reported as the misleading "there is no CDK app here". Now the BOM/UTF-16 cases
// decode correctly and a genuinely-unparseable EXISTING cdk.json throws a specific error.
const APP = 'npx ts-node bin/app.ts';
const cdkJson = (app: string = APP): string => JSON.stringify({ app, context: {} });

describe('resolveApp (#1076 encoding + error surfacing)', () => {
  let dir: string;
  let prev: string;

  beforeEach(() => {
    prev = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'cdkrd-app-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an explicit value short-circuits (no cdk.json read)', () => {
    expect(resolveApp('node app.js')).toBe('node app.js');
  });

  it('reads a plain UTF-8 cdk.json', () => {
    writeFileSync('cdk.json', cdkJson());
    expect(resolveApp(undefined)).toBe(APP);
  });

  it('reads a UTF-8 BOM cdk.json (Notepad / PowerShell utf8)', () => {
    writeFileSync(
      'cdk.json',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cdkJson())])
    );
    expect(resolveApp(undefined)).toBe(APP);
  });

  it('reads a UTF-16 LE cdk.json (PowerShell 5.1 `> cdk.json` default)', () => {
    writeFileSync('cdk.json', Buffer.from(`﻿${cdkJson()}`, 'utf16le'));
    expect(resolveApp(undefined)).toBe(APP);
  });

  it('reads a UTF-16 BE cdk.json', () => {
    const le = Buffer.from(`﻿${cdkJson()}`, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    writeFileSync('cdk.json', be);
    expect(resolveApp(undefined)).toBe(APP);
  });

  it('returns undefined when no cdk.json exists (genuinely no app here)', () => {
    expect(resolveApp(undefined)).toBeUndefined();
  });

  it('returns undefined for a parseable cdk.json with no `app` (app may come from --app)', () => {
    writeFileSync('cdk.json', JSON.stringify({ context: {} }));
    expect(resolveApp(undefined)).toBeUndefined();
  });

  it('THROWS a specific error for an existing but unparseable cdk.json (not the "no app" lie)', () => {
    writeFileSync('cdk.json', '{ "app": "x", }'); // trailing comma
    expect(() => resolveApp(undefined)).toThrow(/cdk\.json exists but is not valid JSON/);
  });
});

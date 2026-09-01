import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// #1841 — every AWS SDK client constructed under src/ must spread the shared config
// (READ_RETRY or CLIENT_TIMEOUTS), because that spread is what carries the
// requestHandler getter: the #1066 timeouts AND the proxy routing. A client built
// without it silently dials out directly, which behind a corporate proxy fails at the
// first call with a certificate error naming neither the proxy nor the client — invisible
// in review and to every unit test, and the next new SDK-override reader or revert writer
// is exactly where it would decay. cdkd fences the same invariant with
// scripts/check-aws-client-defaults.ts; here a unit test is enough because cdkrd has ONE
// shared config module instead of a per-site helper call.
//
// The scan binds to the IMPORT plus the `Client` suffix, not to either alone: the import
// alone matches commands/paginators from the same packages, and the suffix alone matches
// non-SDK classes named `*Client`. Aliased imports (`S3Client as Foo`) are tracked by
// their LOCAL name.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The one construction allowed OUTSIDE the shared config, with why. An entry here is
// LOAD-BEARING in both directions: a site that starts conforming (or disappears) makes
// the assertion on ALLOWED below fail, so the list can only shrink.
const ALLOWED: ReadonlyArray<{ file: string; identifier: string; reason: string }> = [
  {
    file: 'commands/resolve-stacks.ts',
    identifier: 'CloudControlClient',
    // the region probe: config.region() resolves from env + ini files, no request is
    // ever sent — and it calls client.destroy(), which must not tear down shared state
    reason: 'region probe, never sends a request',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface SdkImports {
  /** Local names of `*Client` identifiers imported from `@aws-sdk/client-*` packages. */
  clientNames: Set<string>;
  /** Every VALUE (non-type) exported name imported from those packages. */
  valueExports: string[];
}

function sdkImports(source: string): SdkImports {
  const clientNames = new Set<string>();
  const valueExports: string[] = [];
  // `[^}]*` (never `[\s\S]*?`) is load-bearing: an unanchored non-greedy span can start
  // at a PRECEDING non-SDK brace import (e.g. `import { get } from 'node:https';`) and
  // swallow everything up to the first `} from '@aws-sdk/client-…'`, silently dropping
  // that package's clients from the population — measured on this very branch, where the
  // node:https import ahead of the ACM import made `new ACMClient(...)` invisible.
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'@aws-sdk\/client-[^']+'/g;
  for (const m of source.matchAll(importRe)) {
    const typeOnlyImport = m[1] !== undefined;
    for (const rawSpec of m[2]!.split(',')) {
      const trimmed = rawSpec.trim();
      if (trimmed === '') continue;
      const typeSpec = typeOnlyImport || /^type\s/.test(trimmed);
      const spec = trimmed.replace(/^type\s+/, '');
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(spec);
      const local = asMatch ? asMatch[2]! : spec;
      const exported = asMatch ? asMatch[1]! : spec;
      // the EXPORTED name decides SDK-client-ness; the LOCAL name is what `new` uses
      if (exported.endsWith('Client')) clientNames.add(local);
      if (!typeSpec) valueExports.push(exported);
    }
  }
  return { clientNames, valueExports };
}

/** The balanced-paren argument span of `new <name>(` starting at `openParen`. */
function argumentSpan(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1); // unbalanced — return the rest, the check still runs
}

interface Site {
  file: string;
  identifier: string;
  line: number;
  conforms: boolean;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const path of walk(SRC)) {
    const source = readFileSync(path, 'utf-8');
    const names = sdkImports(source).clientNames;
    if (names.size === 0) continue;
    const rel = path.slice(SRC.length + 1);
    for (const m of source.matchAll(/new\s+([A-Za-z0-9_$]+)\s*\(/g)) {
      const identifier = m[1]!;
      if (!names.has(identifier)) continue;
      const span = argumentSpan(source, m.index! + m[0].length - 1);
      sites.push({
        file: rel,
        identifier,
        line: source.slice(0, m.index!).split('\n').length,
        conforms: span.includes('READ_RETRY') || span.includes('CLIENT_TIMEOUTS'),
      });
    }
  }
  return sites;
}

describe('#1841 every AWS SDK client construction carries the shared config', () => {
  const sites = collectSites();

  it('finds the population (floors against a collapsed parse)', () => {
    // calibrated 2026-09-02 (post regex fix): 188 sites across 9 files. A parser
    // regression that finds nothing must fail HERE, loudly, not report "no gaps".
    expect(sites.length).toBeGreaterThanOrEqual(150);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(6);
  });

  it('every construction spreads READ_RETRY or CLIENT_TIMEOUTS, or is explicitly allowed', () => {
    const violations = sites.filter(
      (s) => !s.conforms && !ALLOWED.some((a) => a.file === s.file && a.identifier === s.identifier)
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} new ${v.identifier}(...)`),
      'an AWS SDK client built without the shared config bypasses the #1066 timeouts AND ' +
        'the #1841 proxy routing — spread READ_RETRY (read path) or CLIENT_TIMEOUTS ' +
        '(write path), or add a justified ALLOWED entry'
    ).toEqual([]);
  });

  it('no aggregate SDK client classes sneak past the Client-suffix binding', () => {
    // The scan binds on the `Client` suffix, so the v2-style aggregate classes each
    // package also exports (`S3`, `EC2`, `Lambda` — subclasses of `XClient`) would be
    // INVISIBLE to it: a `new S3({ region })` is a real transport construction the
    // fence could never flag. Close the hole at the IMPORT instead: every VALUE
    // specifier imported from `@aws-sdk/client-*` must be a Client, a Command, or an
    // Exception class (the three shapes the tree uses). The day an aggregate class —
    // or a paginator/waiter helper — is imported, this fails loudly and the scanner
    // gets extended deliberately rather than silently bypassed.
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      const source = readFileSync(path, 'utf-8');
      for (const exported of sdkImports(source).valueExports) {
        if (!/(Client|Command|Exception)$/.test(exported)) {
          offenders.push(`${path.slice(SRC.length + 1)}: ${exported}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the ALLOWED list stays honest (each entry matches EXACTLY one live gap)', () => {
    for (const a of ALLOWED) {
      const matches = sites.filter(
        (s) => s.file === a.file && s.identifier === a.identifier && !s.conforms
      );
      expect(
        matches,
        `${a.file} / ${a.identifier}: a stale ALLOWED entry hides the next real gap in ` +
          'the same file — remove or tighten it'
      ).toHaveLength(1);
    }
  });
});

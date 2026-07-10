// #1323: on the `--app` COMMAND path, synthApp must verify the app subprocess actually
// (re)WROTE the cloud assembly's manifest.json this run. An app that exits 0 without
// synthesizing (a no-op wrapper, a swallowed synth failure, a dropped app.synth()) otherwise
// makes cdkrd silently consume the STALE manifest a prior run left in cdk.out — which becomes
// the DESIRED state (false declared drift; a revert writes stale values back to AWS).
//
// synthApp drives real toolkit-lib (heavy to mock), so we unit-test the extracted pure helper
// assertAssemblyFresh against a real temp manifest.json whose mtime we control via
// fs.utimesSync — mirroring how synth.ts extracts other pure, exported helpers so the synth
// logic is testable without a real assembly.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { ASSEMBLY_FRESHNESS_TOLERANCE_MS, assertAssemblyFresh } from '../src/synth/synth.js';

describe('assertAssemblyFresh (#1323)', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkrd-synth-1323-'));
    manifest = join(dir, 'manifest.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Set the temp manifest's mtime to `ms` (an epoch-millis instant).
  const setMtime = (ms: number) => {
    const secs = ms / 1000;
    utimesSync(manifest, secs, secs);
  };

  it('throws when the manifest is STALE (mtime older than synthStart minus tolerance)', () => {
    writeFileSync(manifest, '{}');
    const synthStart = Date.now();
    // A prior run's manifest: mtime well before this run started (minutes old).
    setMtime(synthStart - 60_000);
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).toThrow(
      /did not produce a cloud assembly/
    );
  });

  it('does NOT throw when the manifest is FRESH (rewritten at/after synthStart)', () => {
    writeFileSync(manifest, '{}');
    const synthStart = Date.now();
    // A genuine synth rewrites the manifest during toolkit.synth → mtime >= synthStart.
    setMtime(synthStart + 500);
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).not.toThrow();
  });

  it('does NOT throw for a fast rewrite whose mtime is a touch BEFORE synthStart (tolerance)', () => {
    writeFileSync(manifest, '{}');
    const synthStart = Date.now();
    // Within the slack window: coarse mtime granularity / a tiny backward clock tick must not
    // falsely flag a real, fast rewrite as stale.
    setMtime(synthStart - (ASSEMBLY_FRESHNESS_TOLERANCE_MS - 500));
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).not.toThrow();
  });

  it('throws just OUTSIDE the tolerance window (mtime older than synthStart minus tolerance)', () => {
    writeFileSync(manifest, '{}');
    const synthStart = Date.now();
    setMtime(synthStart - (ASSEMBLY_FRESHNESS_TOLERANCE_MS + 1000));
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).toThrow(
      /did not produce a cloud assembly/
    );
  });

  it('throws when the manifest does NOT exist at all (defensive)', () => {
    // no writeFileSync — manifest.json is absent
    const synthStart = Date.now();
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).toThrow(
      /did not produce a cloud assembly/
    );
  });

  it('is a NO-OP on the DIRECTORY path (isDir=true) even for a stale/absent manifest', () => {
    // The dir path (fromAssemblyDirectory) is intentional stale consumption — never flagged.
    const synthStart = Date.now();
    // absent manifest, stale, whatever — isDir short-circuits before any stat.
    expect(() => assertAssemblyFresh(manifest, synthStart, true)).not.toThrow();
    writeFileSync(manifest, '{}');
    setMtime(synthStart - 60_000);
    expect(() => assertAssemblyFresh(manifest, synthStart, true)).not.toThrow();
  });

  it('includes the manifest path in the error message', () => {
    writeFileSync(manifest, '{}');
    const synthStart = Date.now();
    setMtime(synthStart - 60_000);
    expect(() => assertAssemblyFresh(manifest, synthStart, false)).toThrow(manifest);
  });
});

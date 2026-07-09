// #781: a stack DELETED out of band must not be indistinguishable from a
// never-deployed one. `check` catches the DescribeStacks "does not exist" error and
// today prints "not deployed yet — skipped" + exit 0 — so `check --fail` / `--strict`
// wrongly stay green on a stack whose committed baseline PROVES it was once deployed.
//
// The fix probes `.cdkrd/baselines/` for a `<stackName>.<accountId>.<region>.json`
// baseline (across ANY account/region axis, since the gone stack's env is unknown).
// If one exists → deleted-out-of-band drift → --fail (and --strict) exit 1. If none
// exists → keep the benign skip + exit 0. This test drives the pure `hasBaselineForStack`
// probe (filesystem-only, no AWS) plus `finalCheckExit`, mirroring the catch's exit math.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { baselinePath } from '../src/baseline/baseline-file.js';
import { finalCheckExit, hasBaselineForStack } from '../src/commands/check.js';

const STACK = 'MyStack';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

// The exit the not-deployed catch computes for a stack whose baseline presence is
// `baselinePresent`, given --fail / --strict. Mirrors check.ts's catch branch so the
// test pins the exact exit-code contract without spinning up the whole AWS gather.
function notDeployedExit(baselinePresent: boolean, fail: boolean, strict: boolean): number {
  if (!baselinePresent) return 0; // "not deployed yet — skipped", worst untouched
  return Math.max(finalCheckExit(1, fail), strict ? 1 : 0);
}

describe('#781 deleted-out-of-band stack surfaces as drift, not a skip', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-deleted-781-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  async function writeBaseline(stack: string, account: string, region: string): Promise<void> {
    const p = baselinePath(stack, account, region);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({
        schemaVersion: 2,
        stackName: stack,
        region,
        accountId: account,
        resources: [],
      }),
      'utf8'
    );
  }

  describe('hasBaselineForStack', () => {
    it('is false when no .cdkrd/baselines/ directory exists at all', () => {
      expect(hasBaselineForStack(STACK)).toBe(false);
    });

    it('is true once a baseline for the stack is present', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK)).toBe(true);
    });

    it('matches across ANY account/region axis (the gone stack env is unknown)', async () => {
      // Recorded in a different account+region than any we could reconstruct — still proof
      // the stack was deployed, so it must match on the `<stackName>.` filename prefix.
      await writeBaseline(STACK, '999988887777', 'ap-northeast-1');
      expect(hasBaselineForStack(STACK)).toBe(true);
    });

    it('#986: matches a baseline whose on-disk name differs only in CASE', async () => {
      // On a case-insensitive FS (macOS/Windows) `mystack` and `MyStack` map to ONE
      // baseline file; `loadBaseline`'s `readFile` opens it either way. The existence probe
      // must agree — a case-SENSITIVE prefix match missed the file and silently downgraded a
      // truly deleted stack to a benign skip (exit 0). Baseline recorded as `MyStack.…json`,
      // probed as `mystack`, must count. Passes on case-sensitive Linux CI too: the compare
      // is case-insensitive in the code, independent of the FS's own case behavior.
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(hasBaselineForStack('mystack')).toBe(true);
    });

    it('#986: the case-insensitive match still guards against a bare-prefix collision', async () => {
      // `MyStackExtra.<...>.json` must NOT satisfy hasBaselineForStack('mystack') even with
      // the case-folded compare — the `<stackName>.` separator still bounds the prefix.
      await writeBaseline('MyStackExtra', ACCOUNT, REGION);
      expect(hasBaselineForStack('mystack')).toBe(false);
    });

    it('does not match a DIFFERENT stack whose name shares no prefix', async () => {
      await writeBaseline('OtherStack', ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK)).toBe(false);
    });

    it('does not false-match a stack name that is a prefix of a different stack', async () => {
      // `MyStackExtra.<...>.json` must NOT satisfy hasBaselineForStack('MyStack') — the
      // `<stackName>.` separator guards against a bare-prefix collision.
      await writeBaseline('MyStackExtra', ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK)).toBe(false);
    });

    it('ignores non-baseline files in the directory (e.g. a stray .txt)', async () => {
      const p = baselinePath(STACK, ACCOUNT, REGION);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(join(dirname(p), `${STACK}.note.txt`), 'x', 'utf8');
      expect(hasBaselineForStack(STACK)).toBe(false);
    });
  });

  describe('exit-code contract of the not-deployed catch (#781)', () => {
    it('baseline present + --fail → exit 1 (deleted-out-of-band drift fails)', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK), true, false)).toBe(1);
    });

    it('baseline present + --strict (no --fail) → exit 1 (missing stack is a coverage gap)', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK), false, true)).toBe(1);
    });

    it('baseline present, report-only (no --fail/--strict) → exit 0 but still surfaced', async () => {
      // R53: report-only mode never fails on drift; the drift line is still printed
      // (that side of the contract is covered by the message, not the exit code).
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK), false, false)).toBe(0);
    });

    it('NO baseline (genuinely never deployed) + --fail --strict → exit 0 (benign skip)', () => {
      expect(hasBaselineForStack(STACK)).toBe(false);
      expect(notDeployedExit(hasBaselineForStack(STACK), true, true)).toBe(0);
    });
  });
});

// #781: a stack DELETED out of band must not be indistinguishable from a
// never-deployed one. `check` catches the DescribeStacks "does not exist" error and
// today prints "not deployed yet — skipped" + exit 0 — so `check --fail` / `--strict`
// wrongly stay green on a stack whose committed baseline PROVES it was once deployed.
//
// The fix probes `.cdkrd/baselines/` for a `<stackName>.<accountId>.<region>.json`
// baseline in the REGION being checked (account wildcarded — the gone stack's account is
// unknown without STS — but region IS known and must match, #942), matched
// case-insensitively so it agrees with loadBaseline's readFile on macOS/Windows (#986).
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
      expect(hasBaselineForStack(STACK, REGION)).toBe(false);
    });

    it('is true once a baseline for the stack in this region is present', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK, REGION)).toBe(true);
    });

    it('matches across ANY account axis in this region (the gone stack account is unknown)', async () => {
      // Recorded under a different account than any we could reconstruct — still proof the
      // stack was deployed in THIS region, so account stays wildcarded and it must match.
      await writeBaseline(STACK, '999988887777', REGION);
      expect(hasBaselineForStack(STACK, REGION)).toBe(true);
    });

    it('#942: does NOT match a baseline recorded in a DIFFERENT region', async () => {
      // Region-blind matching falsely reports a same-named stack that was never deployed in
      // region B as "deleted out of band" merely because a baseline exists in region A.
      await writeBaseline(STACK, ACCOUNT, 'us-east-1');
      expect(hasBaselineForStack(STACK, 'eu-west-1')).toBe(false); // wrong region → no match
      expect(hasBaselineForStack(STACK, 'us-east-1')).toBe(true); // right region → match
    });

    it('#986: matches a case-differing on-disk baseline (mirrors loadBaseline readFile)', async () => {
      // `record` wrote `mystack.<acct>.<region>.json`; the stack is later checked as `MyStack`.
      // On a case-insensitive FS both names resolve to ONE file, so `loadBaseline`'s readFile
      // would open it — `hasBaselineForStack` must agree via a case-insensitive compare.
      await writeBaseline('mystack', ACCOUNT, REGION);
      expect(hasBaselineForStack('MyStack', REGION)).toBe(true);
    });

    it('#986: matches a baseline whose on-disk name differs only in CASE', async () => {
      // On a case-insensitive FS (macOS/Windows) `mystack` and `MyStack` map to ONE
      // baseline file; `loadBaseline`'s `readFile` opens it either way. The existence probe
      // must agree — a case-SENSITIVE prefix match missed the file and silently downgraded a
      // truly deleted stack to a benign skip (exit 0). Baseline recorded as `MyStack.…json`,
      // probed as `mystack`, must count. Passes on case-sensitive Linux CI too: the compare
      // is case-insensitive in the code, independent of the FS's own case behavior.
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(hasBaselineForStack('mystack', REGION)).toBe(true);
    });

    it('#986: the case-insensitive match still guards against a bare-prefix collision', async () => {
      // `MyStackExtra.<...>.json` must NOT satisfy hasBaselineForStack('mystack') even with
      // the case-folded compare — the `<stackName>.` separator still bounds the prefix.
      await writeBaseline('MyStackExtra', ACCOUNT, REGION);
      expect(hasBaselineForStack('mystack', REGION)).toBe(false);
    });

    it('does not match a DIFFERENT stack whose name shares no prefix', async () => {
      await writeBaseline('OtherStack', ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK, REGION)).toBe(false);
    });

    it('does not false-match a stack name that is a prefix of a different stack', async () => {
      // `MyStackExtra.<...>.json` must NOT satisfy hasBaselineForStack('MyStack') — the
      // `<stackName>.` separator guards against a bare-prefix collision.
      await writeBaseline('MyStackExtra', ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK, REGION)).toBe(false);
    });

    it('ignores non-baseline files in the directory (e.g. a stray .txt)', async () => {
      const p = baselinePath(STACK, ACCOUNT, REGION);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(join(dirname(p), `${STACK}.note.txt`), 'x', 'utf8');
      expect(hasBaselineForStack(STACK, REGION)).toBe(false);
    });
  });

  // #1046: when the CURRENT account id is known (resolved from any successfully-checked
  // sibling stack in the same `check` run), the `<accountId>` segment is PINNED — the
  // account-axis twin of the #942 region gate. A baseline for the same stack+region but a
  // DIFFERENT account must NOT match, or a stack never deployed in the current account is
  // falsely reported "deleted out of band" merely because ANOTHER account's baseline exists.
  describe('#1046 hasBaselineForStack pins the account segment when the account is known', () => {
    const CURRENT = ACCOUNT; // 111122223333 — the account this run operates in
    const OTHER = '999988887777'; // a DIFFERENT account with a same-name+region baseline

    it('does NOT match a DIFFERENT account baseline when the current account is known', async () => {
      // Multi-account pattern: account A recorded a baseline; we now `check` in account B
      // where the stack was never deployed. Wildcarding the account falsely matches A.
      await writeBaseline(STACK, OTHER, REGION);
      expect(hasBaselineForStack(STACK, REGION, CURRENT)).toBe(false); // pinned → no false drift
      expect(hasBaselineForStack(STACK, REGION)).toBe(true); // account unknown → #942 wildcard
    });

    it('DOES match the CURRENT account baseline (genuine deleted-out-of-band drift)', async () => {
      await writeBaseline(STACK, CURRENT, REGION);
      expect(hasBaselineForStack(STACK, REGION, CURRENT)).toBe(true);
    });

    it('with a known account, still requires the REGION to match too (#942 stays intact)', async () => {
      await writeBaseline(STACK, CURRENT, 'us-east-1');
      expect(hasBaselineForStack(STACK, 'eu-west-1', CURRENT)).toBe(false); // wrong region
      expect(hasBaselineForStack(STACK, 'us-east-1', CURRENT)).toBe(true); // right region+account
    });

    it('with a known account, matches a case-differing on-disk baseline (#986 stays intact)', async () => {
      // The account+region tail is compared case-insensitively alongside the stack prefix.
      await writeBaseline('mystack', CURRENT, REGION);
      expect(hasBaselineForStack('MyStack', REGION, CURRENT)).toBe(true);
    });

    it('with a known account, when ONLY the other account baseline exists → no match', async () => {
      // Both baselines absent for CURRENT: only OTHER present. Pinned probe answers false.
      await writeBaseline(STACK, OTHER, 'us-east-1');
      await writeBaseline(STACK, OTHER, 'eu-west-1');
      expect(hasBaselineForStack(STACK, REGION, CURRENT)).toBe(false);
    });

    it('with a known account, still guards against a bare-prefix collision', async () => {
      // `MyStackExtra.<current>.<region>.json` must NOT satisfy the `MyStack` probe.
      await writeBaseline('MyStackExtra', CURRENT, REGION);
      expect(hasBaselineForStack(STACK, REGION, CURRENT)).toBe(false);
    });

    it('an empty-string account id is treated as unknown (falls back to region-only)', async () => {
      // `desired.accountId` derives from a stackId ARN split — a malformed ARN yields ''.
      // Guard against pinning `..<region>` (which would match nothing): '' is falsy so it
      // takes the #942 wildcard path, preserving the pre-#1046 signal rather than breaking.
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(hasBaselineForStack(STACK, REGION, '')).toBe(true);
    });
  });

  describe('exit-code contract of the not-deployed catch (#781)', () => {
    it('baseline present + --fail → exit 1 (deleted-out-of-band drift fails)', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK, REGION), true, false)).toBe(1);
    });

    it('baseline present + --strict (no --fail) → exit 1 (missing stack is a coverage gap)', async () => {
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK, REGION), false, true)).toBe(1);
    });

    it('baseline present, report-only (no --fail/--strict) → exit 0 but still surfaced', async () => {
      // R53: report-only mode never fails on drift; the drift line is still printed
      // (that side of the contract is covered by the message, not the exit code).
      await writeBaseline(STACK, ACCOUNT, REGION);
      expect(notDeployedExit(hasBaselineForStack(STACK, REGION), false, false)).toBe(0);
    });

    it('NO baseline (genuinely never deployed) + --fail --strict → exit 0 (benign skip)', () => {
      expect(hasBaselineForStack(STACK, REGION)).toBe(false);
      expect(notDeployedExit(hasBaselineForStack(STACK, REGION), true, true)).toBe(0);
    });
  });
});

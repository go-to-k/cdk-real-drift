import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

/**
 * Fence for the two jobs `.github/workflows/ci.yml` grew when the `main` branch
 * ruleset started requiring a status check — `ci-ok` and `release-pr-not-stale`.
 *
 * `ci-ok` is the SINGLE check the ruleset requires, and with auto-merge armed on
 * the release PR and on dependabot PRs, nobody is reading the checks at the
 * moment a merge happens. So the failure that matters is not "went red when it
 * should have been green" — that is loud and self-correcting — but "went GREEN
 * having examined nothing", which is indistinguishable from a clean run at
 * every surface a human or a hook looks at. Three such vacuities are reachable:
 *
 *   1. A job is added to the file and not to `ci-ok`'s `needs:`. It is then
 *      outside the gate and can be red under a green `ci-ok`.
 *   2. `if: always()` is dropped. `ci-ok` is then SKIPPED whenever an upstream
 *      job fails — and a skipped required check counts as PASSING.
 *   3. `RESULTS` renders empty. `for r in ${RESULTS}` runs zero times and the
 *      step exits 0. The `EXPECTED_UPSTREAM` count is the floor, and it is only
 *      a floor while it EQUALS the `needs:` length, asserted here rather than
 *      trusted to the comment beside it.
 *
 * `release-pr-not-stale` is a CHECKER and carries a checker's obligation: prove
 * it still REFUSES, not merely that it ran. Three of its properties are fenced:
 *
 *   a. The CHECKOUT, not just the shell. Deleting `ref: head.sha` makes the
 *      runner use the default `refs/pull/N/merge`, which has the base already
 *      merged in — so every `merge-base --is-ancestor` answers yes and the job
 *      passes on a stale branch while its shell is still perfectly correct.
 *   b. EACH ARM of the loop separately. With a fixture that only ever moves
 *      `CHANGELOG.md` on main, the manifest arm never discriminates and gating
 *      the ancestry test on the filename survives undetected.
 *   c. The shell itself, EXTRACTED and EXECUTED, never re-typed — a copy here
 *      would keep passing after the workflow's copy was broken — and selected
 *      BY STEP NAME, so inserting a step ahead of it cannot retarget it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(repoRoot, '.github', 'workflows', 'ci.yml');
const RELEASE_YML = join(repoRoot, '.github', 'workflows', 'release.yml');

const GATE_JOB = 'ci-ok';
const GATE_STEP = 'every upstream job succeeded or was skipped';
const STALE_JOB = 'release-pr-not-stale';
const STALE_STEP = 'release-please-owned files on main must be ancestors of this branch';
const CHANGELOG = 'CHANGELOG.md';
const MANIFEST = '.release-please-manifest.json';

interface CiWorkflow {
  on?: Record<
    string,
    { paths?: unknown; 'paths-ignore'?: unknown; branches?: unknown; types?: unknown } | null
  >;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string[];
      env?: Record<string, string>;
      permissions?: unknown;
      'continue-on-error'?: unknown;
      steps?: {
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
        'continue-on-error'?: unknown;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

function workflow(): CiWorkflow {
  return parseYaml(readFileSync(CI_YML, 'utf8')) as CiWorkflow;
}

/** A named step's `run:` body, selected by NAME rather than by index. */
function runBody(jobId: string, stepName: string): string {
  const step = workflow().jobs[jobId]?.steps?.find((s) => s.name === stepName);
  expect(
    step?.run,
    `the step \`${stepName}\` is gone from job \`${jobId}\` in .github/workflows/ci.yml. ` +
      `If it was renamed, update this extractor; if it was REMOVED, restore it — this ` +
      `suite then attests to nothing.`
  ).toBeTruthy();
  return step?.run as string;
}

/**
 * Whether a step `if:` is exempt from the unconditional-step rule.
 *
 * `always()` is exempt outright — the step runs on every path, so it can never
 * be why a job reported success having done nothing.
 *
 * `failure()` / `cancelled()` are exempt ONLY when the job carries at least one
 * UNCONDITIONAL step. A diagnostic dump gated on `failure()` beside real work
 * is correct code (this repo carries exactly that step), but the SAME condition
 * on a job's only work skips on every green path while the job reports
 * `success`.
 *
 * What stays banned outright is a condition that can be FALSE on an ordinary
 * run (`github.event_name == 'push'`, an output test).
 */
function isExemptStepCondition(condition: string, jobSteps: { if?: string }[]): boolean {
  const bare = condition
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
  if (bare === 'always()') return true;
  if (bare !== 'failure()' && bare !== 'cancelled()') return false;
  // The qualifier is the whole point: a diagnostic dump gated on `failure()`
  // BESIDE real work is correct code, but the same condition on a job's ONLY
  // work skips on every green path while the job reports `success` — exactly
  // the vacuity ci-ok cannot see. An earlier cut exempted these two
  // unconditionally and readmitted that mutation.
  return jobSteps.some((s) => s.if === undefined);
}

function bashStatus(
  script: string,
  env: Record<string, string>,
  cwd?: string
): { status: number; output: string } {
  try {
    const output = execFileSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('ci-ok — the single required status check', () => {
  it('gates every other job in the workflow', () => {
    const jobs = workflow().jobs;
    const names = Object.keys(jobs);
    // Non-vacuity floor: with one job the set equality below is trivially
    // satisfiable and this case attests to nothing.
    expect(
      names.length,
      'ci.yml has fewer jobs than when this fence was written — re-read it before lowering this floor.'
    ).toBeGreaterThanOrEqual(4);

    const gated = new Set(jobs[GATE_JOB]?.needs ?? []);
    const ungated = names.filter((n) => n !== GATE_JOB && !gated.has(n));
    expect(
      ungated,
      `these ci.yml jobs are not in ci-ok's \`needs:\`, so they are outside the merge gate ` +
        `and can be red while the required check is green: ${ungated.join(', ')}. Add them ` +
        `to \`needs:\` and bump EXPECTED_UPSTREAM.`
    ).toEqual([]);

    const phantom = [...gated].filter((n) => !names.includes(n));
    expect(phantom, `ci-ok \`needs:\` names jobs that do not exist: ${phantom.join(', ')}`).toEqual(
      []
    );
  });

  it('runs even when an upstream job failed', () => {
    expect(workflow().jobs[GATE_JOB]?.if).toBe('always()');
  });

  it('declares the upstream count its shell checks against', () => {
    const job = workflow().jobs[GATE_JOB];
    expect(job?.env?.['EXPECTED_UPSTREAM']).toBe(String(job?.needs?.length ?? -1));
  });

  it('takes the results through env, not as inlined expression text', () => {
    expect(runBody(GATE_JOB, GATE_STEP)).not.toContain('${{');
    expect(workflow().jobs[GATE_JOB]?.env?.['RESULTS']).toContain('join(needs.*.result');
  });

  it('lets the shell exit status decide the job', () => {
    // The cases below EXECUTE the extracted shell, so they attest that its TEXT
    // is correct — never that the runner acts on its exit status. Two one-line
    // additions sever that link and make the job report success with nothing
    // decided: `continue-on-error: true` (the failure stops failing the job)
    // and a step-level `if:` that is false (the step is skipped). `?? false`
    // because an explicit `continue-on-error: false` is identical to absence.
    for (const jobId of [GATE_JOB, STALE_JOB]) {
      const job = workflow().jobs[jobId];
      const stepName = jobId === GATE_JOB ? GATE_STEP : STALE_STEP;
      const step = job?.steps?.find((s) => s.name === stepName);
      expect(step?.['continue-on-error'] ?? false, `${jobId} step`).toBe(false);
      expect(step?.if, `${jobId} step`).toBeUndefined();
      expect(job?.['continue-on-error'] ?? false, `${jobId} job`).toBe(false);
    }
  });

  it('keeps every gated job unconditional and failing', () => {
    // Three levers let an upstream job stop contributing a real verdict while
    // ci-ok still counts it, each landing a different `needs.*.result`:
    //   job `if:`               -> `skipped`, which ci-ok ACCEPTS
    //   job `continue-on-error` -> a FAILED job reports `success`
    //   step `if:`              -> `success` with the step never executed
    // All three give `seen == EXPECTED_UPSTREAM` and a green gate over a CI
    // that decided nothing; the first two also read green in the Checks UI.
    const jobs = workflow().jobs;
    const ALLOWED_CONDITIONAL = new Set([GATE_JOB, STALE_JOB]);
    const offenders: string[] = [];
    for (const [name, j] of Object.entries(jobs)) {
      if (j.if !== undefined && !ALLOWED_CONDITIONAL.has(name)) {
        offenders.push(`${name} (job if:)`);
      }
      if ((j['continue-on-error'] ?? false) !== false) {
        offenders.push(`${name} (job continue-on-error)`);
      }
      for (const s of j.steps ?? []) {
        const label = s.name ?? s.run?.split('\n')[0] ?? '<step>';
        if (
          s.if !== undefined &&
          !ALLOWED_CONDITIONAL.has(name) &&
          !isExemptStepCondition(s.if, j.steps ?? [])
        ) {
          offenders.push(`${name} > ${label} (step if:)`);
        }
        // NOT gated on ALLOWED_CONDITIONAL: a step-level `continue-on-error`
        // is the job-level lever one level down — the step fails, the job
        // reports `success`, and it reads green in the Checks UI too.
        if ((s['continue-on-error'] ?? false) !== false) {
          offenders.push(`${name} > ${label} (step continue-on-error)`);
        }
      }
    }
    expect(
      offenders,
      `these ci.yml jobs can report a verdict ci-ok counts without earning it: ` +
        `${offenders.join(', ')}. ci-ok accepts a SKIPPED upstream and cannot tell a ` +
        `continue-on-error success from a real one, so any of these makes the gate green ` +
        `over a CI that ran nothing.`
    ).toEqual([]);
  });

  it('pins the least privilege each new job was given', () => {
    // ci.yml has no top-level `permissions:`, so deleting either of these
    // silently restores the repo-default token to a job that runs shell.
    expect(workflow().jobs[GATE_JOB]?.permissions).toEqual({});
    expect(workflow().jobs[STALE_JOB]?.permissions).toEqual({ contents: 'read' });
  });

  it('runs on every PR, so ci-ok can be a required check at all', () => {
    // A `paths:`-filtered workflow does not start when nothing matches, so the
    // required check never reports and every PR blocks forever at "Expected".
    // `branches:` narrows the same way.
    const pr = workflow().on?.['pull_request'];
    expect(pr, 'ci.yml no longer triggers on `pull_request`').not.toBeUndefined();
    expect(pr?.paths).toBeUndefined();
    expect(pr?.['paths-ignore']).toBeUndefined();
    // `types:` is the same trap with a different key: narrowing it to
    // `[opened]` means a later push creates a head sha with NO check run, so
    // the required check sits at "Expected" on that sha forever.
    expect(pr?.types).toBeUndefined();
    expect(pr?.branches).toEqual(['main']);
  });

  describe('the extracted step', () => {
    const run = (results: string) =>
      bashStatus(runBody(GATE_JOB, GATE_STEP), { RESULTS: results, EXPECTED_UPSTREAM: '3' }).status;

    it('passes when every upstream job succeeded', () => {
      expect(run('success success success')).toBe(0);
    });

    it('passes when an upstream job was skipped', () => {
      expect(run('success skipped success')).toBe(0);
    });

    it('fails on a failed upstream job', () => {
      expect(run('success failure success')).not.toBe(0);
    });

    it('fails on a cancelled upstream job', () => {
      expect(run('success cancelled success')).not.toBe(0);
    });

    it('fails when the results render empty', () => {
      // THE case this floor exists for: the loop runs zero times, so without
      // the count check "all good" and "examined nothing" are the same exit 0.
      expect(run('')).not.toBe(0);
    });

    it('fails when fewer results arrive than the needs list declares', () => {
      expect(run('success success')).not.toBe(0);
    });
  });
});

describe('release-pr-not-stale', () => {
  let scratch: string;
  let cloneSeq = 0;

  interface Fixture {
    remote: string;
    tip: string;
    base: string;
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Hermetic: a maintainer's global config must not decide the verdict.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    }).trim();
  }

  function commit(repo: string, file: string, body: string, subject: string): string {
    writeFileSync(join(repo, file), body);
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', subject);
    return git(repo, 'rev-parse', 'HEAD');
  }

  /**
   * A main history ending in a commit that touches ONLY `lastFile`, so a branch
   * cut at `base` is stale by that file and by nothing else — which is what
   * makes each arm of the production loop separately observable.
   *
   * `seedManifest: false` builds a history where the manifest NEVER existed, so
   * `git rev-list -1 ... -- <manifest>` comes back empty and the fail-closed
   * branch is reached with the CHANGELOG arm passing.
   */
  function makeRemote(name: string, lastFile: string, seedManifest = true): Fixture {
    const origin = join(scratch, `${name}-origin`);
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, CHANGELOG), '# Changelog\n\n## 0.1.0\n');
    if (seedManifest) writeFileSync(join(origin, MANIFEST), '{ ".": "0.1.0" }\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'chore(release): 0.1.0');
    const base = commit(origin, 'src.txt', 'work\n', 'feat: something');
    const tip =
      lastFile === CHANGELOG
        ? commit(
            origin,
            CHANGELOG,
            '# Changelog\n\n## 0.1.0 (normalized)\n',
            'chore(docs): normalize'
          )
        : commit(origin, MANIFEST, '{ ".": "0.1.0-edited" }\n', 'chore: hand-edit the manifest');

    const remote = join(scratch, `${name}-remote.git`);
    execFileSync('git', ['clone', '-q', '--bare', origin, remote], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { remote, tip, base };
  }

  function releaseBranchAt(fixture: Fixture, at: string): string {
    const wt = join(scratch, `wt-${cloneSeq++}`);
    execFileSync('git', ['clone', '-q', fixture.remote, wt], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(wt, 'checkout', '-q', '-b', 'release-please--branches--main', at);
    commit(wt, 'RELEASE_NOTE.txt', 'release-please commit\n', 'chore(release): 0.1.1');
    return wt;
  }

  const guard = (cwd: string) =>
    bashStatus(
      runBody(STALE_JOB, STALE_STEP),
      { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      cwd
    );

  let changelogFixture: Fixture;
  let manifestFixture: Fixture;
  let noManifestFixture: Fixture;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cdkrd-release-stale-'));
    changelogFixture = makeRemote('changelog', CHANGELOG);
    manifestFixture = makeRemote('manifest', MANIFEST);
    noManifestFixture = makeRemote('nomanifest', CHANGELOG, false);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('the checkout the guard depends on', () => {
    it('takes the PR HEAD, not the default merge ref', () => {
      // `refs/pull/N/merge` has the base already merged in, so every ancestry
      // question answers "yes" no matter how stale the branch is. Losing this
      // `ref:` is the one mutation that makes the whole job vacuous while its
      // shell is still perfectly correct.
      const checkout = workflow().jobs[STALE_JOB]?.steps?.find((s) =>
        (s.uses ?? '').startsWith('actions/checkout@')
      );
      expect(checkout, `job \`${STALE_JOB}\` no longer checks anything out`).toBeTruthy();
      expect(checkout?.with?.['ref']).toBe('${{ github.event.pull_request.head.sha }}');
    });

    it('fetches the full history the ancestry test needs', () => {
      const checkout = workflow().jobs[STALE_JOB]?.steps?.find((s) =>
        (s.uses ?? '').startsWith('actions/checkout@')
      );
      expect(checkout?.with?.['fetch-depth']).toBe(0);
    });
  });

  describe('each owned file separately', () => {
    it('passes on a release branch cut from current main', () => {
      const { status, output } = guard(releaseBranchAt(changelogFixture, 'origin/main'));
      expect(status).toBe(0);
      expect(output).not.toContain('::error::');
    });

    it('fails when main moved CHANGELOG.md after the branch was cut', () => {
      const { status, output } = guard(releaseBranchAt(changelogFixture, changelogFixture.base));
      expect(status).not.toBe(0);
      expect(output).toContain(CHANGELOG);
      expect(output).toContain(changelogFixture.tip);
      expect(output).toContain('re-run release.yml');
      // Only this arm may fire here — otherwise the case cannot tell a
      // per-file check from one that refuses everything.
      expect(output).not.toContain(`${MANIFEST} was last changed`);
    });

    it('fails when main moved the manifest after the branch was cut', () => {
      // Without this case the manifest arm never discriminates, and gating the
      // ancestry test on `[ "${f}" = "CHANGELOG.md" ]` survives the suite.
      const { status, output } = guard(releaseBranchAt(manifestFixture, manifestFixture.base));
      expect(status).not.toBe(0);
      expect(output).toContain(MANIFEST);
      expect(output).toContain(manifestFixture.tip);
      expect(output).not.toContain(`${CHANGELOG} was last changed`);
    });

    it('fails closed when an owned file has no history on main', () => {
      // "The guard cannot answer" must not read as "the guard found nothing
      // wrong". The CHANGELOG arm passes in this fixture, so the non-zero exit
      // can only come from the empty-tip branch.
      const { status, output } = guard(releaseBranchAt(noManifestFixture, 'origin/main'));
      expect(status).not.toBe(0);
      expect(output).toContain('cannot evaluate staleness');
      expect(output).toContain(MANIFEST);
      expect(output).not.toContain(`${CHANGELOG} has no commit history`);
    });
  });

  describe('the job stays wired to the thing it guards', () => {
    it('checks exactly the files release-please owns', () => {
      // Read the loop's actual subject list rather than asserting a substring
      // is absent — `not.toContain('package.json')` passes over an empty string
      // and over a shell that checks nothing at all.
      const m = /^for f in (.+); do$/m.exec(runBody(STALE_JOB, STALE_STEP));
      expect(m, "the guard's `for f in ...; do` loop is gone").not.toBeNull();
      expect((m as RegExpExecArray)[1]!.trim().split(/\s+/).sort()).toEqual(
        [CHANGELOG, MANIFEST].sort()
      );
    });

    it('is guarded by the branch prefix release-please actually produces', () => {
      expect(workflow().jobs[STALE_JOB]?.if).toBe(
        "startsWith(github.head_ref, 'release-please--')"
      );
      // RESIDUAL, stated rather than implied away: this repo has not yet had a
      // release-please-created PR (batched releases landed recently and no
      // release has been cut), so the prefix is release-please's documented
      // default rather than an observed branch name here. The FIRST release PR
      // must be checked — if its head does not start with `release-please--`,
      // this job skips on every PR and `ci-ok` stays green over it.
      //
      // `branch-prefix` is NOT a release-please config key, so asserting its
      // absence would be a fence over something that can never appear. What can
      // actually move the prefix is a release-please MAJOR, and the action is
      // SHA-pinned — so the pin's major is the real change vector: bumping it
      // must force a re-check, and dependabot's patch bumps must not.
      const pin = /googleapis\/release-please-action@[0-9a-f]{40} # v(\d+)/.exec(
        readFileSync(RELEASE_YML, 'utf8')
      );
      expect(pin, 'release.yml no longer SHA-pins googleapis/release-please-action').not.toBeNull();
      expect(
        (pin as RegExpExecArray)[1],
        'release-please was bumped to a new MAJOR. Its release branch prefix is a property ' +
          `of that major — re-verify that a release PR's head still starts with ` +
          "'release-please--' before updating this expectation."
      ).toBe('4');
    });
  });
});

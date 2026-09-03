import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

/**
 * v0 release fence.
 *
 * cdk-real-drift deliberately stays at major version 0 — a v1.0.0 release must
 * be impossible to ship by accident. Releases are batched via release-please
 * (release-please-config.json + .github/workflows/release.yml), and the v0
 * requirement rests on two independent layers this suite pins:
 *
 *   1. `bump-minor-pre-major: true` — while the version is < 1.0.0, a
 *      breaking-change commit bumps MINOR (0.x.0), never 1.0.0. Without it,
 *      release-please's default maps a `feat!:` / BREAKING CHANGE footer
 *      straight to 1.0.0.
 *   2. The publish job's guard step — it hard-fails before `npm publish`
 *      when the computed major is not 0, which also covers the paths layer 1
 *      cannot (a manual `Release-As: 1.0.0` footer, a hand-edited manifest).
 *
 * Losing either layer is silent until the wrong tag exists, so both are
 * fenced here rather than trusted — statically (each guard arm pinned to its
 * OWN `exit 1`, bounded at the arm's closing `fi` so a sibling arm's exit
 * cannot satisfy it) and dynamically (the guard's run block is executed under
 * bash against a stub package.json, the idiom
 * tests/pr-inherit-issue-labels.test.ts uses for its workflow script). The
 * version-shaped assertions on the manifest and package.json are the same
 * invariant read from the state files: they go red the moment anything moves
 * the tracked version out of 0.x, and deleting them is the deliberate act a
 * real 1.0.0 would require.
 *
 * This suite replaces tests/releaserc-header-pattern.test.ts: that one pinned
 * the semantic-release parserOpts in the now-deleted .releaserc.json (compound
 * `fix(a)+fix(b):` titles, `!` breaking markers), a concern release-please's
 * own conventional-commit parser absorbs — while compound titles stay rejected
 * at the PR gate by scripts/check-pr-title.mjs (tests/check-pr-title.test.ts).
 */

const url = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

type WorkflowStep = { run?: string; name?: string; uses?: string };

function publishJob(): {
  publish: { if?: string; permissions?: Record<string, string>; steps: WorkflowStep[] };
  guard: WorkflowStep;
} {
  const workflow = parseYaml(readFileSync(url('../.github/workflows/release.yml'), 'utf8'));
  const publish = workflow.jobs?.publish;
  expect(publish, 'publish job missing from release.yml').toBeDefined();
  const guard = (publish.steps as WorkflowStep[]).find((s) => s.run?.includes('"$MAJOR" != "0"'));
  expect(guard, 'v0 guard step missing from the publish job').toBeDefined();
  return { publish, guard: guard! };
}

describe('release-please v0 fence', () => {
  it('bump-minor-pre-major keeps breaking changes below 1.0.0', () => {
    const config = JSON.parse(readFileSync(url('../release-please-config.json'), 'utf8'));
    const pkg = config.packages?.['.'];
    expect(pkg).toBeDefined();
    expect(pkg['release-type']).toBe('node');
    expect(pkg['bump-minor-pre-major']).toBe(true);
  });

  it('release PR titles keep the chore(release) convention', () => {
    const config = JSON.parse(readFileSync(url('../release-please-config.json'), 'utf8'));
    const pattern = config.packages?.['.']?.['pull-request-title-pattern'];
    // chore(release) passes the pr-title-check workflow and, squashed, does
    // not feed a feat/fix bump back into the next release computation.
    expect(pattern).toMatch(/^chore\(release\): /);
    expect(pattern).toContain('${version}');
  });

  it('the tracked versions are still 0.x', () => {
    const manifest = JSON.parse(readFileSync(url('../.release-please-manifest.json'), 'utf8'));
    expect(manifest['.']).toMatch(/^0\./);
    const pkg = JSON.parse(readFileSync(url('../package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^0\./);
  });

  it('the publish job refuses a non-0 major before npm publish', () => {
    const { publish, guard } = publishJob();
    // Publish only runs on an actual release (the release-PR merge), never on
    // the ordinary pushes that merely update the release PR. Pinned to the
    // EXACT expression: a weakening such as `always() ||` must fail here, not
    // slip through a substring check.
    expect(publish.if).toBe("${{ needs.release-please.outputs.release_created == 'true' }}");
    // npm auth is OIDC trusted publishing; without id-token: write the publish
    // silently falls back to needing a token secret.
    expect(publish.permissions?.['id-token']).toBe('write');

    // Pin each guard arm with its own exit 1 — the run block carries several
    // `exit 1`s, so a bare toContain('exit 1') would stay green if one arm
    // were softened to a warning. Each if-arm's body is bounded at its FIRST
    // `fi` line before asserting, so the lazy match cannot cross into a
    // sibling arm and be satisfied by that arm's exit 1.
    const pkgArm = guard.run!.match(/if \[ "\$PKG_VERSION" != "\$VERSION" \]; then\n([^]*?)\nfi\n/);
    expect(pkgArm, 'PKG_VERSION mismatch arm missing').not.toBeNull();
    expect(pkgArm![1]).toContain('exit 1');
    const majorArm = guard.run!.match(/if \[ "\$MAJOR" != "0" \]; then\n([^]*?)\nfi\n/);
    expect(majorArm, 'MAJOR != 0 arm missing').not.toBeNull();
    expect(majorArm![1]).toContain('exit 1');
    // The 0.* case arm is the third, independent spelling of the same fence.
    // The default arm is the LAST arm of the guard block, so the lazy match
    // below has no later exit 1 to borrow.
    expect(guard.run).toContain('0.*)');
    expect(guard.run).toMatch(/\*\)\n[^]*?\bexit 1\n/);

    const steps = publish.steps;
    const guardIndex = steps.indexOf(guard);
    // Exact pin on purpose: any flag added to npm publish (e.g. --provenance)
    // must be a deliberate test edit, not a silent drift of what ships.
    const publishIndex = steps.findIndex((s) => s.run?.trim() === 'npm publish');
    expect(
      publishIndex,
      'no step whose run is exactly `npm publish` (a flag change must update this pin)'
    ).toBeGreaterThan(-1);
    expect(guardIndex, 'v0 guard must run before npm publish').toBeLessThan(publishIndex);
  });

  it('the guard, executed under bash, rejects a v1 tag and passes a matching 0.x', () => {
    // Static pins say the arms LOOK right; this runs the extracted block the
    // way the runner would, against a stub package.json.
    const { guard } = publishJob();
    const runGuard = (opts: {
      tag: string;
      major: string;
      pkgVersion: string;
    }): { status: number; output: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'rp-v0-guard-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'stub', version: opts.pkgVersion })
        );
        try {
          execFileSync('bash', ['-c', guard.run!], {
            cwd: dir,
            env: { ...process.env, TAG_NAME: opts.tag, MAJOR: opts.major },
            stdio: 'pipe',
          });
          return { status: 0, output: '' };
        } catch (e) {
          const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
          return {
            status: err.status ?? 1,
            output: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`,
          };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // Each refusal must exit non-zero AND emit the ::error:: workflow command —
    // that distinguishes the guard REFUSING from the block merely crashing
    // non-zero (e.g. a missing command under set -eu). The command is captured
    // from stdout+stderr combined: `echo "::error::…"` writes to STDOUT (GitHub
    // reads workflow commands there), while an incidental crash — bash's own
    // "command not found" — lands on stderr with no ::error:: anywhere.
    // A v1.0.0 release with everything else consistent MUST be refused.
    const v1 = runGuard({ tag: 'v1.0.0', major: '1', pkgVersion: '1.0.0' });
    expect(v1.status).not.toBe(0);
    expect(v1.output).toContain('::error::');
    // A package.json that disagrees with the tag MUST be refused even at 0.x.
    const mismatch = runGuard({ tag: 'v0.28.0', major: '0', pkgVersion: '0.27.0' });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.output).toContain('::error::');
    // The legitimate case — matching 0.x tag/package, major 0 — passes.
    expect(runGuard({ tag: 'v0.28.0', major: '0', pkgVersion: '0.28.0' }).status).toBe(0);
  });

  it('the release-please action is pinned to a full commit sha', () => {
    const workflow = parseYaml(readFileSync(url('../.github/workflows/release.yml'), 'utf8'));
    const steps: Array<{ uses?: string }> = workflow.jobs['release-please'].steps;
    const action = steps.find((s) => s.uses?.startsWith('googleapis/release-please-action@'));
    expect(action).toBeDefined();
    expect(action?.uses).toMatch(/@[0-9a-f]{40}( |$)/);
  });
});

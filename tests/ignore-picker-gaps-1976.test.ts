// #1976 — the interactive `cdkrd ignore` picker offers the coverage gaps `check --strict`
// fails on (#1969 / #1970): an unacknowledged `skipped` resource (a RESOURCE-level rule) and
// a FAILED-read `readGap` (a property-level rule), labelled apart from drift. By-nature
// readGaps, `Custom::*` skips and already-acknowledged gaps are NOT offered, and `--yes` /
// non-interactive runs never acknowledge a gap. End to end: a rule written through the
// picker makes the next `check --strict` pass.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Finding } from '../src/types.js';

let gathered: Finding[] = [];
vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () =>
    Promise.resolve([{ stackName: 'MyStack', region: 'us-east-1', template: {} }]),
}));
vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
vi.mock('../src/synth/synth.js', () => ({
  synthApp: () => Promise.resolve([{ stackName: 'MyStack', region: 'us-east-1', template: {} }]),
  discoverStacks: () =>
    Promise.resolve([{ stackName: 'MyStack', region: 'us-east-1', template: {} }]),
}));
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: () =>
    Promise.resolve({
      desired: {
        stackName: 'MyStack',
        region: 'us-east-1',
        accountId: '111122223333',
        resources: [],
        rawTemplate: '{}',
        ctx: {},
      },
      // a fresh copy per gather — applyIgnores must not see a previous run's stamps
      findings: gathered.map((f) => ({ ...f })),
      schemas: new Map(),
      liveByLogical: new Map(),
    }),
}));
vi.mock('../src/commands/progress.js', async (orig) => ({
  ...(await orig<typeof import('../src/commands/progress.js')>()),
  gatherWithProgress: (_show: boolean, _label: string, fn: () => unknown) => fn(),
}));
let tty = true;
vi.mock('../src/cli-args.js', async (orig) => ({
  ...(await orig<typeof import('../src/cli-args.js')>()),
  isInteractive: () => tty,
}));
// The picker: record what it was offered, pick the rows `pick` selects.
let offered: { value: string; label: string; selected: boolean }[] = [];
let header = '';
let pick: (o: { value: string; label: string }) => boolean = () => false;
vi.mock('../src/commands/bulk-multiselect.js', () => ({
  bulkMultiselect: (message: string, options: typeof offered) => {
    header = message;
    offered = options;
    return Promise.resolve(options.filter((o) => pick(o)).map((o) => o.value));
  },
}));

import { applyIgnores, loadConfig } from '../src/config/config-file.js';
import { runCheck, strictCoverageExit } from '../src/commands/check.js';
import { runIgnore } from '../src/commands/ignore.js';
import {
  acknowledgeableGaps,
  ignoreSelectOptions,
  ignoreStack,
} from '../src/commands/stack-actions.js';

const SCOPE = { stackName: 'MyStack', accountId: '111122223333', region: 'us-east-1' };

// A CDK-synthesized skip (construct path present) — the #1969 issue's exact attachment.
const attachmentSkip = (): Finding => ({
  tier: 'skipped',
  logicalId: 'DatabaseClusterSecretAttachmentDC8466C0',
  constructPath: 'MyStack/Database/Cluster/Secret/Attachment',
  resourceType: 'AWS::SecretsManager::SecretTargetAttachment',
  path: '',
  note: 'CC API: AccessDeniedException',
});
// A skip on an assembly WITHOUT aws:cdk:path metadata — only the logicalId form matches.
const bareSkip = (): Finding => ({
  tier: 'skipped',
  logicalId: 'Handle1A2B3C4D',
  resourceType: 'AWS::CloudFormation::WaitConditionHandle',
  path: '',
  note: 'unsupported type (no Cloud Control read handler)',
});
// The #1970 failed read (kms:Decrypt on the Lambda environment), CDK-synthesized…
const envReadGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'ClusterRestorerVerifierABCD1234',
  constructPath: 'MyStack/ClusterRestorer/Verifier',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment',
  note: 'supplement read failed — property unverifiable (grant the missing read permission)',
  readFailed: true,
});
// …and the PR #1972 live-test shape: no construct path, so only `Fn9270CBC0.Environment`.
const bareEnvReadGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'Fn9270CBC0',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment',
  note: 'supplement read failed — property unverifiable (grant the missing read permission)',
  readFailed: true,
});
const kmsAliasGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'Bucket',
  resourceType: 'AWS::S3::Bucket',
  path: 'BucketEncryption.KMSMasterKeyID',
  note: 'AWS-managed KMS alias unresolved (kms:ListAliases unavailable)',
  compareOnly: true,
});
const writeOnlyGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'Db',
  resourceType: 'AWS::RDS::DBCluster',
  path: 'MasterUserPassword',
  note: 'write-only — cannot be read back',
  writeOnly: true,
});
const notReturnedGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'Db',
  resourceType: 'AWS::RDS::DBCluster',
  path: 'Foo',
  note: 'declared but not returned by live read',
});
const customSkip = (): Finding => ({
  tier: 'skipped',
  logicalId: 'CustomS3AutoDeleteObjects',
  resourceType: 'Custom::S3AutoDeleteObjects',
  path: '',
  note: 'custom resource — no cloud-side model',
});
const declaredDrift = (): Finding => ({
  tier: 'declared',
  logicalId: 'Bucket',
  constructPath: 'MyStack/Bucket/Resource',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration.Status',
  desired: 'Enabled',
  actual: 'Suspended',
});

describe('#1976 acknowledgeableGaps — exactly the gaps --strict fails on', () => {
  it.each([
    ['an AccessDenied skip (construct path)', attachmentSkip(), true],
    ['an unsupported-type skip (no construct path)', bareSkip(), true],
    ['a failed-read readGap', envReadGap(), true],
    ['a compareOnly readGap (kms:ListAliases unavailable)', kmsAliasGap(), true],
    ['a write-only readGap', writeOnlyGap(), false],
    ['a not-returned readGap', notReturnedGap(), false],
    ['a Custom::* skip (#724, never a --strict failure)', customSkip(), false],
    ['an acknowledged skip', { ...attachmentSkip(), acknowledgedBy: 'r' }, false],
    ['an acknowledged failed-read readGap', { ...envReadGap(), acknowledgedBy: 'r' }, false],
    ['declared drift (offered as drift, not as a gap)', declaredDrift(), false],
  ])('%s → offered=%s, and agrees with the --strict gate', (_l, f, gap) => {
    expect(acknowledgeableGaps([f])).toHaveLength(gap ? 1 : 0);
    expect(strictCoverageExit(true, [f], [])).toBe(gap ? 1 : 0);
  });
});

describe('#1976 ignoreSelectOptions labels a gap apart from drift', () => {
  it('skip / failed read rows say "coverage gap"; drift keeps its tier; keys never alias', () => {
    const rows = ignoreSelectOptions(
      [declaredDrift(), attachmentSkip(), envReadGap(), bareSkip()],
      'MyStack'
    );
    expect(rows.map((r) => r.label)).toEqual([
      'Bucket/Resource.VersioningConfiguration.Status (declared)',
      'Database/Cluster/Secret/Attachment [coverage gap — resource not read: CC API: AccessDeniedException]',
      'ClusterRestorer/Verifier.Environment [coverage gap — property read failed]',
      'Handle1A2B3C4D [coverage gap — resource not read: unsupported type (no Cloud Control read handler)]',
    ]);
    expect(rows.every((r) => !r.selected)).toBe(true);
    expect(new Set(rows.map((r) => r.value)).size).toBe(rows.length);
  });

  it('a resource-level failed read (empty path) says "resource read failed"', () => {
    expect(ignoreSelectOptions([{ ...bareEnvReadGap(), path: '' }])[0]!.label).toBe(
      'Fn9270CBC0 [coverage gap — resource read failed]'
    );
  });

  it('a readGap row never aliases a drift row at the same logicalId + path', () => {
    const drift: Finding = { ...envReadGap(), tier: 'declared', readFailed: undefined };
    const rows = ignoreSelectOptions([drift, envReadGap()]);
    expect(rows[0]!.value).not.toBe(rows[1]!.value);
  });
});

describe('#1976 ignoreStack — gap rows in the picker', () => {
  let cwd: string;
  let dir: string;
  let err: string[];
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-ignore-gaps-1976-'));
    process.chdir(dir);
    err = [];
    offered = [];
    header = '';
    pick = () => false;
    tty = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      err.push(String(m));
    });
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    gathered = [];
  });

  const all = (): Finding[] => [
    declaredDrift(),
    attachmentSkip(),
    bareSkip(),
    envReadGap(),
    bareEnvReadGap(),
    writeOnlyGap(),
    notReturnedGap(),
    customSkip(),
    { ...kmsAliasGap(), logicalId: 'Acked', acknowledgedBy: 'Acked' },
    // drift UNDER an acknowledged gap's rule (same resource + property subtree)
    {
      tier: 'declared',
      logicalId: 'ClusterRestorerVerifierABCD1234',
      constructPath: 'MyStack/ClusterRestorer/Verifier',
      resourceType: 'AWS::Lambda::Function',
      path: 'Environment.Variables.MODE',
      desired: 'a',
      actual: 'b',
    },
  ];

  it('offers drift + the --strict gaps only, and the header explains acknowledging', async () => {
    await ignoreStack({ stackName: 'MyStack', findings: all(), yes: false, interactive: true });
    expect(offered.map((o) => o.label)).toEqual([
      'Bucket/Resource.VersioningConfiguration.Status (declared)',
      'ClusterRestorer/Verifier.Environment.Variables.MODE (declared)',
      'Database/Cluster/Secret/Attachment [coverage gap — resource not read: CC API: AccessDeniedException]',
      'Handle1A2B3C4D [coverage gap — resource not read: unsupported type (no Cloud Control read handler)]',
      'ClusterRestorer/Verifier.Environment [coverage gap — property read failed]',
      'Fn9270CBC0.Environment [coverage gap — property read failed]',
    ]);
    expect(header).toContain('ACKNOWLEDGED instead');
    expect(header).toContain('remove it after granting the read');
  });

  it('a gaps-only stack still opens the picker (no "no ignorable drift" short-circuit)', async () => {
    pick = (o) => o.label.includes('coverage gap');
    const r = await ignoreStack({
      stackName: 'MyStack',
      findings: [attachmentSkip()],
      yes: false,
      interactive: true,
      accountId: '111122223333',
      region: 'us-east-1',
    });
    expect(r).toMatchObject({ wrote: true, added: 1 });
    // RESOURCE-level — the bare id, never a property glob (`<id>.*` cannot match a skip).
    expect((await loadConfig()).ignore).toEqual([
      {
        path: 'Database/Cluster/Secret/Attachment',
        stack: 'MyStack',
        account: '111122223333',
        region: 'us-east-1',
      },
    ]);
  });

  it('--yes ignores the drift only and leaves every gap unacknowledged, saying so', async () => {
    const r = await ignoreStack({
      stackName: 'MyStack',
      findings: all(),
      yes: true,
      interactive: true,
    });
    expect(r.added).toBe(2);
    expect(offered).toEqual([]); // no picker under --yes
    expect((await loadConfig()).ignore.map((x) => (typeof x === 'string' ? x : x.path))).toEqual([
      'Bucket/Resource.VersioningConfiguration.Status',
      'ClusterRestorer/Verifier.Environment.Variables.MODE',
    ]);
    expect(err.join('\n')).toContain(
      'note: MyStack: 4 coverage gap(s) left unacknowledged — only the interactive picker acknowledges a gap (run `cdkrd ignore MyStack` in a terminal without --yes)'
    );
  });

  it('non-interactive with only gaps: not a refusal, nothing written, a note names the count', async () => {
    const r = await ignoreStack({
      stackName: 'MyStack',
      findings: [attachmentSkip(), envReadGap()],
      yes: false,
      interactive: false,
    });
    expect(r).toEqual({ wrote: false, refused: false, added: 0 });
    expect(existsSync('.cdkrd/ignore.yaml')).toBe(false);
    expect(err.join('\n')).toContain('2 coverage gap(s) left unacknowledged');
  });

  it('every rule the picker writes acknowledges its own gap via applyIgnores', async () => {
    pick = (o) => o.label.includes('coverage gap');
    const findings = all();
    await ignoreStack({ findings, yes: false, interactive: true, ...SCOPE });
    const config = await loadConfig();
    expect(config.ignore.map((x) => (typeof x === 'string' ? x : x.path))).toEqual([
      'Database/Cluster/Secret/Attachment',
      'Handle1A2B3C4D',
      'ClusterRestorer/Verifier.Environment',
      'Fn9270CBC0.Environment',
    ]);
    const after = applyIgnores(findings, SCOPE, config);
    expect(
      after
        .filter((f) => f.tier === 'skipped' || f.tier === 'readGap')
        .map((f) => [f.logicalId, f.path, f.acknowledgedBy !== undefined])
    ).toEqual([
      ['DatabaseClusterSecretAttachmentDC8466C0', '', true],
      ['Handle1A2B3C4D', '', true],
      ['ClusterRestorerVerifierABCD1234', 'Environment', true],
      ['Fn9270CBC0', 'Environment', true],
      ['Db', 'MasterUserPassword', false],
      ['Db', 'Foo', false],
      ['CustomS3AutoDeleteObjects', '', false],
      ['Acked', 'BucketEncryption.KMSMasterKeyID', true],
    ]);
    // the unpicked drift on ANOTHER resource stays drift…
    expect(after[0]!.tier).toBe('declared');
    // …while drift inside a picked gap's subtree IS ignored: the rule is an ordinary ignore
    // rule (documented in the picker header and README — remove it once the read works)
    const subtreeDrift = after.find(
      (f) =>
        f.logicalId === 'ClusterRestorerVerifierABCD1234' &&
        f.path === 'Environment.Variables.MODE'
    );
    expect(subtreeDrift?.tier).toBe('ignored');
    expect(strictCoverageExit(true, findings, [])).toBe(1);
    expect(strictCoverageExit(true, after, [])).toBe(0);
  });

  it('end to end: `cdkrd ignore` picker → `check --strict` exits 1 before, 0 after', async () => {
    gathered = [attachmentSkip(), bareSkip(), envReadGap(), bareEnvReadGap(), writeOnlyGap()];
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(1);
    pick = (o) => o.label.includes('coverage gap');
    expect(await runIgnore(['MyStack'])).toBe(0);
    expect(offered).toHaveLength(4); // the write-only readGap was not offered
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(0);
    // re-running the picker offers nothing: every gap is now acknowledged
    offered = [];
    expect(await runIgnore(['MyStack'])).toBe(0);
    expect(offered).toEqual([]);
  });

  it('end to end: picking only SOME gaps leaves --strict failing on the rest', async () => {
    gathered = [attachmentSkip(), bareEnvReadGap()];
    pick = (o) => o.label.startsWith('Fn9270CBC0.Environment');
    expect(await runIgnore(['MyStack'])).toBe(0);
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(1);
  });
});

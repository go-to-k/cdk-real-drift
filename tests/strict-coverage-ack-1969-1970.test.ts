// #1969 — an `.cdkrd/ignore.yaml` rule can ACKNOWLEDGE a known-unreadable (`skipped`)
// resource: it stays listed (tier unchanged, `acknowledgedBy` stamped, `acknowledged-skip`
// footer line) but no longer fails `--strict`. Unacknowledged skips still fail.
// #1970 — a readGap whose read FAILED (a denied supplement read: Lambda Environment under a
// kms:Decrypt deny, cognito-sync, …) or whose comparison needs a denied lookup (an
// `alias/aws/*` KMS alias with kms:ListAliases unavailable, `compareOnly`) is incomplete
// coverage: `--strict` fails on it. By-nature readGaps (write-only, not returned, GetTemplate
// mask) stay informational. The #1969 acknowledgement clears it too.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyIgnores, type CdkrdConfig, parseConfigRaw } from '../src/config/config-file.js';
import { classifyResource } from '../src/diff/classify.js';
import { report } from '../src/report/report.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

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
      findings: gathered,
      schemas: new Map(),
      liveByLogical: new Map(),
    }),
}));

import {
  coverageWarning,
  hasCoverageGap,
  readFailureWarning,
  runCheck,
  strictCoverageExit,
} from '../src/commands/check.js';

const SCOPE = { stackName: 'MyStack', accountId: '111122223333', region: 'us-east-1' };

// The issue's exact skip: a CDK DatabaseCluster's generated-secret attachment, whose CC read
// needs secretsmanager:GetSecretValue.
const attachmentSkip = (): Finding => ({
  tier: 'skipped',
  logicalId: 'DatabaseClusterSecretAttachmentDC8466C0',
  constructPath: 'MyStack/Database/Cluster/Secret/Attachment',
  resourceType: 'AWS::SecretsManager::SecretTargetAttachment',
  path: '',
  note: 'CC API: AccessDeniedException',
});

// The issue's exact readGap: a Lambda whose environment is unreadable (kms:Decrypt denied).
const envReadGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'ClusterRestorerVerifierABCD1234',
  constructPath: 'MyStack/ClusterRestorer/Verifier',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment',
  note: 'supplement read failed — property unverifiable (grant the missing read permission)',
  readFailed: true,
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

const kmsAliasGap = (): Finding => ({
  tier: 'readGap',
  logicalId: 'Bucket',
  resourceType: 'AWS::S3::Bucket',
  path: 'BucketEncryption.KMSMasterKeyID',
  note: 'AWS-managed KMS alias unresolved (kms:ListAliases unavailable)',
  compareOnly: true,
});

const cfg = (yaml: string): CdkrdConfig => parseConfigRaw(yaml);
const ack = (f: Finding, yaml: string) => applyIgnores([f], SCOPE, cfg(yaml))[0]!;

describe('#1969 applyIgnores acknowledges a skipped resource at RESOURCE level', () => {
  it.each([
    ['the logicalId', 'DatabaseClusterSecretAttachmentDC8466C0'],
    ['the within-stack construct path', 'Database/Cluster/Secret/Attachment'],
    ['a construct-path ancestor', 'Database/Cluster'],
    ['the full construct path', 'MyStack/Database/Cluster/Secret/Attachment'],
  ])('matches %s — tier stays skipped, acknowledgedBy names the rule', (_label, path) => {
    const out = ack(attachmentSkip(), `ignore:\n  - path: "${path}"\n`);
    expect(out.tier).toBe('skipped');
    expect(out.note).toBe('CC API: AccessDeniedException');
    expect(out.acknowledgedBy).toBe(path);
  });

  it('a property-path rule (`<id>.*`) does NOT acknowledge a skip (no property path)', () => {
    const out = ack(
      attachmentSkip(),
      'ignore:\n  - path: "DatabaseClusterSecretAttachmentDC8466C0.*"\n'
    );
    expect(out.acknowledgedBy).toBeUndefined();
  });

  it('`resourceType` narrows the match; a mismatching type does not acknowledge', () => {
    const hit = ack(
      attachmentSkip(),
      'ignore:\n  - path: Database/Cluster/Secret/Attachment\n    resourceType: AWS::SecretsManager::SecretTargetAttachment\n'
    );
    expect(hit.acknowledgedBy).toBe(
      'Database/Cluster/Secret/Attachment (resourceType:AWS::SecretsManager::SecretTargetAttachment)'
    );
    const miss = ack(
      attachmentSkip(),
      'ignore:\n  - path: Database/Cluster/Secret/Attachment\n    resourceType: AWS::SecretsManager::Secret\n'
    );
    expect(miss.acknowledgedBy).toBeUndefined();
  });

  it('an all-wildcard path is accepted with an EXACT resourceType and acknowledges every resource of it', () => {
    const out = ack(
      attachmentSkip(),
      'ignore:\n  - path: "*"\n    resourceType: AWS::SecretsManager::SecretTargetAttachment\n'
    );
    expect(out.acknowledgedBy).toBeDefined();
  });

  it('a stack-scoped rule for ANOTHER stack does not acknowledge', () => {
    const out = ack(
      attachmentSkip(),
      'ignore:\n  - path: DatabaseClusterSecretAttachmentDC8466C0\n    stack: Other\n'
    );
    expect(out.acknowledgedBy).toBeUndefined();
  });
});

describe('#1970 applyIgnores acknowledges a FAILED-read readGap, never a by-nature one', () => {
  it.each([
    ['resource level', 'ClusterRestorer/Verifier'],
    ['property level', 'ClusterRestorer/Verifier.Environment'],
  ])('acknowledges at %s — tier stays readGap', (_l, path) => {
    const out = ack(envReadGap(), `ignore:\n  - path: ${path}\n`);
    expect(out.tier).toBe('readGap');
    expect(out.acknowledgedBy).toBe(path);
  });

  it('a by-nature readGap is left untouched by a matching rule', () => {
    expect(ack(writeOnlyGap(), 'ignore:\n  - path: Db\n')).toEqual(writeOnlyGap());
  });
});

describe('#1969/#1970 the --strict coverage gate', () => {
  it.each([
    ['an unacknowledged AccessDenied skip', attachmentSkip(), true],
    ['a failed-read readGap (Lambda Environment)', envReadGap(), true],
    ['a compareOnly readGap (kms:ListAliases unavailable)', kmsAliasGap(), true],
    ['a write-only readGap', writeOnlyGap(), false],
    ['a not-returned readGap', notReturnedGap(), false],
    ['an acknowledged skip', { ...attachmentSkip(), acknowledgedBy: 'r' }, false],
    ['an acknowledged failed-read readGap', { ...envReadGap(), acknowledgedBy: 'r' }, false],
  ])('%s → gap=%s', (_l, f, gap) => {
    expect(hasCoverageGap([f], [])).toBe(gap);
    expect(strictCoverageExit(true, [f], [])).toBe(gap ? 1 : 0);
    expect(strictCoverageExit(false, [f], [])).toBe(0);
  });

  it('one acknowledged skip does not mask a second, unacknowledged one', () => {
    const other: Finding = { ...attachmentSkip(), logicalId: 'Other', constructPath: undefined };
    expect(hasCoverageGap([{ ...attachmentSkip(), acknowledgedBy: 'r' }, other], [])).toBe(true);
  });

  it('coverageWarning / readFailureWarning skip acknowledged gaps', () => {
    expect(coverageWarning([{ ...attachmentSkip(), acknowledgedBy: 'r' }], 'MyStack')).toBeNull();
    expect(coverageWarning([attachmentSkip()], 'MyStack')).toContain('1 resource(s)');
    expect(readFailureWarning([{ ...envReadGap(), acknowledgedBy: 'r' }], 'MyStack')).toBeNull();
    expect(readFailureWarning([envReadGap(), writeOnlyGap()], 'MyStack')).toContain(
      '1 propert(ies) could NOT be read'
    );
    expect(readFailureWarning([envReadGap()], 'MyStack')).toContain(
      'ClusterRestorer/Verifier.Environment'
    );
  });
});

describe('#1970 classify marks a supplement read-gap as readFailed', () => {
  const emptySchema: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const res = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'R',
    resourceType: 'AWS::Test::Thing',
    physicalId: 'r-phys',
    declared,
  });

  it('DECLARED and UNDECLARED supplement read-gaps both carry readFailed', () => {
    const findings = classifyResource(
      res({ Environment: { Variables: { A: '1' } } }),
      {},
      emptySchema,
      {
        supplementReadGapPaths: ['Environment', 'CognitoEvents'],
      }
    );
    const gaps = findings.filter((f) => f.tier === 'readGap');
    const byPath = [...gaps].sort((a, b) => a.path.localeCompare(b.path));
    expect(byPath.map((f) => [f.path, f.readFailed])).toEqual([
      ['CognitoEvents', true],
      ['Environment', true],
    ]);
  });

  it('a by-nature readGap (declared write-only) does NOT carry readFailed', () => {
    const schema = { ...emptySchema, writeOnly: new Set(['MasterUserPassword']) };
    const findings = classifyResource(res({ MasterUserPassword: 'x' }), {}, schema);
    const gap = findings.find((f) => f.path === 'MasterUserPassword');
    expect(gap?.tier).toBe('readGap');
    expect(gap?.readFailed).toBeUndefined();
  });
});

describe('#1969/#1970 report footer keeps acknowledged gaps listed, split from the failing ones', () => {
  const footer = (findings: Finding[], verbose = false): string => {
    const lines: string[] = [];
    report(findings, 'MyStack (us-east-1)', { log: (s) => lines.push(s), verbose });
    return lines.join('\n');
  };

  it('an acknowledged skip renders as acknowledged-skip, not as coverage incomplete', () => {
    const out = footer([
      { ...attachmentSkip(), acknowledgedBy: 'Database/Cluster/Secret/Attachment' },
    ]);
    expect(out).toContain(
      'acknowledged-skip=1 — NOT checked, acknowledged in .cdkrd/ignore.yaml (CC AccessDeniedException 1)'
    );
    expect(out).not.toContain('skipped=');
  });

  it('acknowledged and unacknowledged skips each get their own line', () => {
    const out = footer([
      { ...attachmentSkip(), acknowledgedBy: 'r' },
      { ...attachmentSkip(), logicalId: 'Other', constructPath: undefined },
    ]);
    expect(out).toContain('skipped=1 — NOT checked (coverage incomplete');
    expect(out).toContain('acknowledged-skip=1');
  });

  it('--verbose names the acknowledging rule on the row', () => {
    const out = footer(
      [{ ...attachmentSkip(), acknowledgedBy: 'Database/Cluster/Secret/Attachment' }],
      true
    );
    expect(out).toContain('acknowledged by ignore rule "Database/Cluster/Secret/Attachment"');
  });

  it('the readGap line separates failed reads (and acknowledged ones) from by-nature gaps', () => {
    const out = footer([
      envReadGap(),
      { ...envReadGap(), logicalId: 'L2', acknowledgedBy: 'r' },
      writeOnlyGap(),
      notReturnedGap(),
    ]);
    expect(out).toContain(
      'readGap=4 (declared but unverifiable — not drift: 1 read failed — coverage incomplete, grant the missing read permission, 1 read failed, acknowledged in .cdkrd/ignore.yaml, 1 not returned by AWS, 1 write-only)'
    );
  });
});

// End to end through runCheck: the gate must see ignore.yaml (the call-site ORDER — before
// the fix it read the raw gathered findings, so no rule could ever clear it).
describe('#1969/#1970 runCheck --strict honours ignore.yaml acknowledgements', () => {
  let cwd: string;
  let dir: string;
  let err: string[];
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-strict-ack-1969-'));
    process.chdir(dir);
    err = [];
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
  const writeIgnore = async (yaml: string) => {
    await mkdir(join(dir, '.cdkrd'), { recursive: true });
    await writeFile(join(dir, '.cdkrd', 'ignore.yaml'), yaml, 'utf8');
  };

  it('a skip: --strict exits 1 without a rule, 0 once acknowledged', async () => {
    gathered = [attachmentSkip()];
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(1);
    await writeIgnore(
      'ignore:\n  # CI role has no secretsmanager:GetSecretValue by design\n  - path: Database/Cluster/Secret/Attachment\n'
    );
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(0);
  });

  it('a failed-read readGap: --strict exits 1, 0 once acknowledged; --json warns until then', async () => {
    gathered = [envReadGap()];
    expect(await runCheck(['--strict', '--json', 'MyStack'])).toBe(1);
    expect(err.join('\n')).toContain('could NOT be read');
    err.length = 0;
    await writeIgnore('ignore:\n  - path: ClusterRestorer/Verifier.Environment\n');
    expect(await runCheck(['--strict', '--json', 'MyStack'])).toBe(0);
    expect(err.join('\n')).not.toContain('could NOT be read');
  });

  it('--pre-deploy: the same acknowledgement clears the --strict gate there too', async () => {
    gathered = [attachmentSkip(), envReadGap()];
    expect(await runCheck(['--strict', '--pre-deploy', '--no-prompt', 'MyStack'])).toBe(1);
    await writeIgnore(
      'ignore:\n  - path: Database/Cluster/Secret/Attachment\n  - path: ClusterRestorer/Verifier\n'
    );
    expect(await runCheck(['--strict', '--pre-deploy', '--no-prompt', 'MyStack'])).toBe(0);
  });

  it('a by-nature readGap never fails --strict', async () => {
    gathered = [writeOnlyGap(), notReturnedGap()];
    expect(await runCheck(['--strict', '--no-prompt', 'MyStack'])).toBe(0);
  });
});

describe('#1969 config validation of resourceType', () => {
  it('rejects a non-string / empty resourceType', () => {
    expect(() => cfg('ignore:\n  - path: X\n    resourceType: 3\n')).toThrow(
      '"resourceType" must be a string'
    );
    expect(() => cfg('ignore:\n  - path: X\n    resourceType: ""\n')).toThrow('must not be empty');
  });
  it('still rejects an all-wildcard path with a GLOBBED resourceType', () => {
    expect(() => cfg('ignore:\n  - path: "*"\n    resourceType: "AWS::*"\n')).toThrow(
      'all-wildcard'
    );
  });
});
